import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Readable, Transform, pipeline } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import zlib from 'node:zlib';
import archiver from 'archiver';
import * as configJson from 'balena-config-json';
import { OsImageError } from './errors';
import { generateFleetConfig } from './config';
import { balenaCloudApiUrl } from './versions';
import {
  osImageCacheStore,
  type CacheStore,
  type FleetConfigOptions,
  type OsImageFormat,
  type OsImageNetwork,
  type OsImageVariant,
  configSha16,
} from './cacheStore';

const streamPipeline = promisify(pipeline);

export type OsImageJobPhase = 'downloading' | 'injecting' | 'compressing' | 'ready' | 'error';

export interface PrepareOsImageRequest {
  deviceType: string;
  version: string;
  variant: OsImageVariant;
  format: OsImageFormat;
  appId: number;
  fleetName: string;
  network: OsImageNetwork;
  appUpdatePollInterval?: number;
  wifiSsid?: string;
  wifiKey?: string;
}

export interface OsImageJobProgress {
  downloadedBytes: number;
  totalBytes?: number;
}

export interface OsImageJobArtifact {
  filename: string;
  sizeBytes: number;
  format: OsImageFormat;
}

export interface OsImageJob {
  jobId: string;
  phase: OsImageJobPhase;
  progress?: OsImageJobProgress;
  error?: string;
  artifact?: OsImageJobArtifact;
}

interface OsImageJobEntry extends OsImageJob {
  request: PrepareOsImageRequest;
  authorization?: string;
  artifactPath?: string;
}

const jobs = new Map<string, OsImageJobEntry>();

export const getOsImageJob = (jobId: string): OsImageJob | undefined => {
  const entry = jobs.get(jobId);
  if (!entry) {
    return undefined;
  }
  const { jobId: id, phase } = entry;
  return {
    jobId: id,
    phase,
    ...(entry.progress ? { progress: entry.progress } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.artifact ? { artifact: entry.artifact } : {}),
  };
};

export const getOsImageJobArtifactPath = (jobId: string): string | undefined => jobs.get(jobId)?.artifactPath;

export const toFleetConfigOptions = (request: PrepareOsImageRequest): FleetConfigOptions => ({
  appId: request.appId,
  version: request.version,
  network: request.network,
  ...(request.appUpdatePollInterval !== undefined ? { appUpdatePollInterval: request.appUpdatePollInterval } : {}),
  ...(request.variant === 'development' ? { developmentMode: true } : {}),
  ...(request.wifiSsid !== undefined ? { wifiSsid: request.wifiSsid } : {}),
  ...(request.wifiKey !== undefined ? { wifiKey: request.wifiKey } : {}),
});

/**
 * Browser-facing download filename: `<deviceType>-<version>[-dev]-<sanitized fleetName>.<zip|gz>`.
 */
export const artifactDownloadFilename = (request: PrepareOsImageRequest): string => {
  const fleetSlug =
    request.fleetName
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'fleet';
  const variantSuffix = request.variant === 'development' ? '-dev' : '';
  return `${request.deviceType}-${request.version}${variantSuffix}-${fleetSlug}.${request.format}`;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    return (await fsp.stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const silentlyRemove = async (filePath: string | undefined): Promise<void> => {
  if (!filePath) {
    return;
  }
  try {
    await fsp.unlink(filePath);
  } catch {
    // Nothing to clean up.
  }
};

const osImageDownloadUrl = (request: PrepareOsImageRequest): string => {
  const params = new URLSearchParams({
    deviceType: request.deviceType,
    version: request.version,
    fileType: '.img',
  });
  if (request.variant === 'development') {
    params.set('developmentMode', 'true');
  }
  return `${balenaCloudApiUrl()}/download?${params.toString()}`;
};

/**
 * Stream the pristine OS image from balenaCloud into `tmp/`, reporting byte progress, then
 * atomically commit it into the `img/` tier. Called under the pristine cache key's lock.
 */
const downloadPristineImage = async (job: OsImageJobEntry, destination: string): Promise<void> => {
  const { request } = job;

  let response: Response;
  try {
    response = await fetch(osImageDownloadUrl(request));
  } catch (error) {
    throw new OsImageError(
      502,
      `Failed to reach balenaCloud for the OS image of device type '${request.deviceType}': ${
        error instanceof Error ? error.message : 'unknown network error'
      }`,
    );
  }

  if (response.status === 404) {
    throw new OsImageError(
      404,
      `No ${request.variant} balenaOS image found for device type '${request.deviceType}' version '${request.version}'`,
    );
  }
  if (!response.ok) {
    throw new OsImageError(502, `balenaCloud image download failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new OsImageError(502, 'balenaCloud image download returned an empty body');
  }

  const contentLength = Number(response.headers.get('content-length'));
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
  job.progress = { downloadedBytes: 0, ...(totalBytes !== undefined ? { totalBytes } : {}) };

  let downloadedBytes = 0;
  const progressCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.length;
      job.progress = { downloadedBytes, ...(totalBytes !== undefined ? { totalBytes } : {}) };
      callback(null, chunk);
    },
  });

  const tmpFile = path.join(path.dirname(destination), `.${path.basename(destination)}.${job.jobId}.part`);
  await streamPipeline(
    Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
    progressCounter,
    createWriteStream(tmpFile),
  );
  await fsp.rename(tmpFile, destination);
};

/**
 * Compress the injected image into a `tmp/` scratch file, then atomically commit it into
 * the `out/` tier: `.gz` via a zlib gzip stream (level 6), `.zip` via archiver (deflate).
 */
const compressImage = async (
  cacheStore: CacheStore,
  source: string,
  destination: string,
  format: OsImageFormat,
): Promise<void> => {
  const tmpFile = cacheStore.tmpPath(`.${path.basename(destination)}.${randomUUID()}.part`);

  try {
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(tmpFile);
      output.on('error', reject);
      output.on('close', () => resolve());

      if (format === 'gz') {
        const input = createReadStream(source);
        input.on('error', reject);
        const gzip = zlib.createGzip({ level: 6 });
        gzip.on('error', reject);
        input.pipe(gzip).pipe(output);
      } else {
        const archive = archiver('zip', { store: false });
        archive.on('error', reject);
        archive.pipe(output);
        archive.append(createReadStream(source), { name: 'balena-image.img' });
        void archive.finalize().catch(reject);
      }
    });
  } catch (error) {
    await silentlyRemove(tmpFile);
    throw error;
  }

  await cacheStore.commitFile(tmpFile, destination);
};

const runOsImageJob = async (job: OsImageJobEntry, cacheStore: CacheStore): Promise<void> => {
  const { request } = job;
  const configOptions = toFleetConfigOptions(request);
  const configHash = configSha16(configOptions, request.format);

  const pristinePath = cacheStore.pristinePath(request.deviceType, request.version, request.variant);
  const artifactPath = cacheStore.artifactPath(
    request.deviceType,
    request.version,
    request.variant,
    configHash,
    request.format,
  );
  const workingImage = cacheStore.tmpPath(`${job.jobId}.img`);

  job.artifactPath = artifactPath;

  const protectedPaths = [pristinePath, artifactPath, workingImage];
  cacheStore.protect(protectedPaths);

  try {
    await cacheStore.ensureDirs();

    // Identical configuration already prepared: skip straight to ready.
    if (await fileExists(artifactPath)) {
      await cacheStore.touch(artifactPath);
      job.artifact = {
        filename: artifactDownloadFilename(request),
        sizeBytes: await cacheStore.fileSize(artifactPath),
        format: request.format,
      };
      job.phase = 'ready';
      return;
    }

    // Phase 1: ensure the pristine image exists (downloaded at most once per cache key).
    job.phase = 'downloading';
    if (await fileExists(pristinePath)) {
      await cacheStore.touch(pristinePath);
    } else {
      await cacheStore.withLock(`download:${pristinePath}`, async () => {
        // Another job may have finished the download while we waited for the lock.
        if (await fileExists(pristinePath)) {
          return;
        }
        await downloadPristineImage(job, pristinePath);
      });
      await cacheStore.register(pristinePath);
    }

    // Phase 2: generate the fleet config with the caller's JWT and inject it into a copy.
    job.phase = 'injecting';
    job.progress = undefined;
    const config = await generateFleetConfig(job.authorization, configOptions);
    await fsp.copyFile(pristinePath, workingImage);
    await configJson.write(workingImage, undefined, config);

    // Phase 3: compress and commit the artifact.
    job.phase = 'compressing';
    await compressImage(cacheStore, workingImage, artifactPath, request.format);

    job.artifact = {
      filename: artifactDownloadFilename(request),
      sizeBytes: await cacheStore.fileSize(artifactPath),
      format: request.format,
    };
    job.phase = 'ready';
  } catch (error) {
    job.phase = 'error';
    job.progress = undefined;
    job.error =
      error instanceof OsImageError
        ? error.message
        : `Failed to prepare OS image: ${error instanceof Error ? error.message : 'unknown error'}`;
  } finally {
    await silentlyRemove(workingImage);
    cacheStore.unprotect(protectedPaths);
  }
};

/**
 * Register a new prepare job and start the async pipeline. The job phases are
 * `downloading → injecting → compressing → ready|error`; the registry is in-memory, so
 * jobs do not survive a server restart.
 */
export const createOsImageJob = (
  request: PrepareOsImageRequest,
  authorization: string | undefined,
  cacheStore: CacheStore = osImageCacheStore,
): OsImageJob => {
  const jobId = randomUUID();
  const entry: OsImageJobEntry = {
    jobId,
    phase: 'downloading',
    request,
    ...(authorization ? { authorization } : {}),
  };
  jobs.set(jobId, entry);
  void runOsImageJob(entry, cacheStore);
  return getOsImageJob(jobId)!;
};

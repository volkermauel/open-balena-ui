import { createHash, randomUUID } from 'node:crypto';
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
import { generateFleetConfig, applyGatewaySshKeys, parseGatewaySshPublicKeys } from './config';
import { findMirrorAsset } from './versions';
import { extractZipEntry, pickImageEntry, readZipEntries } from './zip';
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

export interface OsImageJobEntry extends OsImageJob {
  request: PrepareOsImageRequest;
  authorization?: string;
  artifactPath?: string;
}

const jobs = new Map<string, OsImageJobEntry>();

/** How long a finished (ready/error) job stays pollable/downloadable before eviction. */
const JOB_RETENTION_MS = 30 * 60 * 1000;

const scheduleJobCleanup = (jobId: string): void => {
  const timer = setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_RETENTION_MS);
  timer.unref?.();
};

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
  ...(request.wifiSsid !== undefined ? { wifiSsid: request.wifiSsid } : {}),
  ...(request.wifiKey !== undefined ? { wifiKey: request.wifiKey } : {}),
});

/**
 * Browser-facing download filename: `<deviceType>-<version>-<sanitized fleetName>.<zip|gz>`.
 * Every part is sanitized so the value is safe to embed in Content-Disposition.
 */
const sanitizeFilenamePart = (value: string, fallback: string): string =>
  value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || fallback;

export const artifactDownloadFilename = (request: PrepareOsImageRequest): string => {
  const deviceType = sanitizeFilenamePart(request.deviceType, 'device');
  const version = sanitizeFilenamePart(request.version, 'os');
  const fleetSlug = sanitizeFilenamePart(request.fleetName, 'fleet');
  return `${deviceType}-${version}-${fleetSlug}.${request.format}`;
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

/**
 * Stream the mirror release asset for (deviceType, version) into `tmp/`, hashing the
 * bytes as they arrive, and atomically commit the sha256-verified archive into the
 * `img/` tier. Called under the pristine cache key's lock. Fails closed — with the
 * partial bytes deleted — when the release has no SHA256SUMS entry or the hash
 * mismatches.
 */
export const downloadPristineMirrorImage = async (job: OsImageJobEntry, destination: string): Promise<void> => {
  const { request } = job;

  const asset = await findMirrorAsset(request.deviceType, request.version);
  if (asset.sha256 === undefined) {
    throw new OsImageError(
      502,
      `The mirror release for device type '${request.deviceType}' version '${request.version}' has no ` +
        `SHA256SUMS entry for '${asset.name}' — refusing to use an unverified image`,
    );
  }

  let response: Response;
  try {
    response = await fetch(asset.url);
  } catch (error) {
    throw new OsImageError(
      502,
      `Failed to reach the mirror for the OS image of device type '${request.deviceType}': ${
        error instanceof Error ? error.message : 'unknown network error'
      }`,
    );
  }

  if (!response.ok) {
    throw new OsImageError(502, `Mirror asset download failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new OsImageError(502, 'Mirror asset download returned an empty body');
  }

  const contentLength = Number(response.headers.get('content-length'));
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
  job.progress = { downloadedBytes: 0, ...(totalBytes !== undefined ? { totalBytes } : {}) };

  let downloadedBytes = 0;
  const hash = createHash('sha256');
  const progressAndHash = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.length;
      hash.update(chunk);
      job.progress = { downloadedBytes, ...(totalBytes !== undefined ? { totalBytes } : {}) };
      callback(null, chunk);
    },
  });

  const tmpFile = path.join(path.dirname(destination), `.${path.basename(destination)}.${job.jobId}.part`);
  try {
    await streamPipeline(
      Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
      progressAndHash,
      createWriteStream(tmpFile),
    );

    const actualSha256 = hash.digest('hex');
    if (actualSha256 !== asset.sha256) {
      throw new OsImageError(
        502,
        `sha256 mismatch for mirror asset '${asset.name}' (expected ${asset.sha256}, got ${actualSha256}) — the download was discarded`,
      );
    }

    await fsp.rename(tmpFile, destination);
  } catch (error) {
    await silentlyRemove(tmpFile);
    throw error;
  }
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

    // Phase 1: ensure the pristine mirror archive exists (downloaded at most once per cache key).
    job.phase = 'downloading';
    if (await fileExists(pristinePath)) {
      await cacheStore.touch(pristinePath);
    } else {
      await cacheStore.withLock(`download:${pristinePath}`, async () => {
        // Another job may have finished the download while we waited for the lock.
        if (await fileExists(pristinePath)) {
          return;
        }
        await downloadPristineMirrorImage(job, pristinePath);
      });
      await cacheStore.register(pristinePath);
    }

    // Phase 2: generate the fleet config with the caller's JWT, unpack the verified
    // archive into a working image, and inject the config into it.
    job.phase = 'injecting';
    job.progress = undefined;
    const config = applyGatewaySshKeys(
      await generateFleetConfig(job.authorization, configOptions),
      parseGatewaySshPublicKeys(process.env.GATEWAY_SSH_PUBLIC_KEYS),
    );
    // The forwarded credentials and wifi secrets are no longer needed once the config exists.
    job.authorization = undefined;
    job.request.wifiSsid = undefined;
    job.request.wifiKey = undefined;
    await extractZipEntry(pristinePath, pickImageEntry(await readZipEntries(pristinePath)), workingImage);
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
    scheduleJobCleanup(job.jobId);
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

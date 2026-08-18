import { json, Router } from 'express';
import { createReadStream } from 'node:fs';
import authorize from '../middleware/authorize';
import dosProtect from '../middleware/dosProtect';
import { OsImageError, listOsVersions, osImageCacheStore } from '../controller/osImage';
import { isValidDeviceTypeSlug, isValidOsVersion } from '../controller/osImage/cacheStore';
import { createOsImageJob, getOsImageJob, getOsImageJobArtifactPath } from '../controller/osImage/prepareJob';
import type { OsImageFormat, CachedVersionInfo } from '../controller/osImage/cacheStore';
import { parseOsConfigRequest, parsePrepareOsImageRequest } from '../controller/osImage/request';
import { applyGatewaySshKeys, generateFleetConfig, parseGatewaySshPublicKeys } from '../controller/osImage/config';
import { configDownloadFilename, toFleetConfigOptions } from '../controller/osImage/prepareJob';

interface ErrorResponse {
  success: false;
  message: string;
}

interface OsVersionsResponse {
  versions: string[];
}

interface OsCacheStatusResponse {
  deviceType: string;
  versions: CachedVersionInfo[];
}

interface PrepareOsImageSuccessResponse {
  jobId: string;
}

interface OsJobResponse {
  jobId: string;
  phase: string;
  progress?: { downloadedBytes: number; totalBytes?: number };
  error?: string;
  artifact?: { filename: string; sizeBytes: number; format: OsImageFormat };
}

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sendOsImageError = (
  res: { status: (code: number) => { json: (body: ErrorResponse) => void } },
  error: unknown,
) => {
  if (error instanceof OsImageError) {
    res.status(error.statusCode).json({ success: false, message: error.message });
    return;
  }
  res
    .status(400)
    .json({ success: false, message: error instanceof Error ? error.message : 'Failed to process OS image request' });
};

const router = Router();

router.use(json());

router.get<Record<string, never>, OsVersionsResponse | ErrorResponse>(
  '/versions',
  ...dosProtect,
  authorize,
  async (req, res) => {
    const deviceType = typeof req.query.deviceType === 'string' ? req.query.deviceType.trim() : '';

    if (!deviceType) {
      res.status(406).json({ success: false, message: 'Request is lacking deviceType in query context' });
      return;
    }
    if (!isValidDeviceTypeSlug(deviceType)) {
      res.status(406).json({ success: false, message: 'Request has an invalid deviceType in query context' });
      return;
    }

    try {
      res.status(200).json({ versions: await listOsVersions(deviceType) });
    } catch (error) {
      sendOsImageError(res, error);
    }
  },
);

router.get<Record<string, never>, OsCacheStatusResponse | ErrorResponse>(
  '/cache-status',
  ...dosProtect,
  authorize,
  async (req, res) => {
    const deviceType = typeof req.query.deviceType === 'string' ? req.query.deviceType.trim() : '';

    if (!deviceType) {
      res.status(406).json({ success: false, message: 'Request is lacking deviceType in query context' });
      return;
    }
    if (!isValidDeviceTypeSlug(deviceType)) {
      res.status(406).json({ success: false, message: 'Request has an invalid deviceType in query context' });
      return;
    }

    try {
      res.status(200).json({ deviceType, versions: await osImageCacheStore.cacheStatus(deviceType) });
    } catch (error) {
      sendOsImageError(res, error);
    }
  },
);

router.post<Record<string, never>, PrepareOsImageSuccessResponse | ErrorResponse>(
  '/prepare',
  ...dosProtect,
  authorize,
  (req, res) => {
    try {
      const request = parsePrepareOsImageRequest(req.body);
      const job = createOsImageJob(request, req.headers.authorization);
      res.status(200).json({ jobId: job.jobId });
    } catch (error) {
      sendOsImageError(res, error);
    }
  },
);
router.post<Record<string, never>, Record<string, unknown> | ErrorResponse>(
  '/config',
  ...dosProtect,
  authorize,
  async (req, res) => {
    try {
      const request = parseOsConfigRequest(req.body);
      // Same generator the image-injection flow uses — including the GATEWAY_SSH_PUBLIC_KEYS
      // merge — but returned straight to the browser instead of being written into an image.
      // The config embeds a freshly minted provisioning API key, so it is per-user and is
      // never cached.
      const config = applyGatewaySshKeys(
        await generateFleetConfig(req.headers.authorization, toFleetConfigOptions(request)),
        parseGatewaySshPublicKeys(process.env.GATEWAY_SSH_PUBLIC_KEYS),
      );
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${configDownloadFilename(request)}"`);
      res.status(200).json(config);
    } catch (error) {
      sendOsImageError(res, error);
    }
  },
);

router.get<{ id: string }, OsJobResponse | ErrorResponse>('/jobs/:id', ...dosProtect, authorize, (req, res) => {
  const job = JOB_ID_PATTERN.test(req.params.id) ? getOsImageJob(req.params.id) : undefined;

  if (!job) {
    res.status(404).json({ success: false, message: 'Unknown OS image job' });
    return;
  }

  res.status(200).json(job);
});

router.get<{ id: string }, ErrorResponse | undefined>(
  '/jobs/:id/download',
  ...dosProtect,
  authorize,
  async (req, res) => {
    const job = JOB_ID_PATTERN.test(req.params.id) ? getOsImageJob(req.params.id) : undefined;

    if (!job) {
      res.status(404).json({ success: false, message: 'Unknown OS image job' });
      return;
    }
    if (job.phase !== 'ready' || !job.artifact) {
      res.status(409).json({ success: false, message: `OS image job is not ready yet (phase: ${job.phase})` });
      return;
    }

    const artifactPath = getOsImageJobArtifactPath(req.params.id);
    if (!artifactPath || !(await osImageCacheStore.hasFile(artifactPath))) {
      res
        .status(404)
        .json({ success: false, message: 'The prepared artifact is no longer available; please prepare again' });
      return;
    }

    const sizeBytes = await osImageCacheStore.fileSize(artifactPath);
    const contentType = job.artifact.format === 'zip' ? 'application/zip' : 'application/gzip';

    await osImageCacheStore.touch(artifactPath);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', sizeBytes.toString());
    res.setHeader('Content-Disposition', `attachment; filename="${job.artifact.filename}"`);
    // Keep the artifact pinned while it streams so concurrent eviction cannot unlink it mid-flight.
    osImageCacheStore.protect([artifactPath]);
    const stream = createReadStream(artifactPath);
    stream.on('error', () => {
      osImageCacheStore.unprotect([artifactPath]);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Failed to stream the prepared artifact' });
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      stream.destroy();
      osImageCacheStore.unprotect([artifactPath]);
    });
    stream.pipe(res);
  },
);

export default router;

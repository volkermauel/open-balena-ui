import { json, Router } from 'express';
import { createReadStream } from 'node:fs';
import authorize from '../middleware/authorize';
import dosProtect from '../middleware/dosProtect';
import { OsImageError, listOsVersions, osImageCacheStore } from '../controller/osImage';
import {
  createOsImageJob,
  getOsImageJob,
  getOsImageJobArtifactPath,
  type PrepareOsImageRequest,
} from '../controller/osImage/prepareJob';
import type {
  OsImageFormat,
  OsImageNetwork,
  OsImageVariant,
  CachedVersionInfo,
} from '../controller/osImage/cacheStore';

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

interface PrepareOsImageRequestBody {
  deviceType?: unknown;
  version?: unknown;
  variant?: unknown;
  format?: unknown;
  appId?: unknown;
  fleetName?: unknown;
  network?: unknown;
  appUpdatePollInterval?: unknown;
  wifiSsid?: unknown;
  wifiKey?: unknown;
}

const VARIANTS: OsImageVariant[] = ['production', 'development'];
const FORMATS: OsImageFormat[] = ['zip', 'gz'];
const NETWORKS: OsImageNetwork[] = ['ethernet', 'wifi'];

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

    try {
      res.status(200).json({ deviceType, versions: await osImageCacheStore.cacheStatus(deviceType) });
    } catch (error) {
      sendOsImageError(res, error);
    }
  },
);

router.post<Record<string, never>, PrepareOsImageSuccessResponse | ErrorResponse, PrepareOsImageRequestBody>(
  '/prepare',
  ...dosProtect,
  authorize,
  (req, res) => {
    const body = req.body ?? {};

    const deviceType = typeof body.deviceType === 'string' ? body.deviceType.trim() : '';
    const version = typeof body.version === 'string' ? body.version.trim() : '';
    const fleetName = typeof body.fleetName === 'string' ? body.fleetName.trim() : '';
    const variant = typeof body.variant === 'string' ? body.variant : '';
    const format = typeof body.format === 'string' ? body.format : '';
    const network = typeof body.network === 'string' ? body.network : '';
    const appId = Number(body.appId);
    const appUpdatePollInterval =
      body.appUpdatePollInterval === undefined || body.appUpdatePollInterval === null
        ? undefined
        : Number(body.appUpdatePollInterval);
    const wifiSsid = typeof body.wifiSsid === 'string' && body.wifiSsid.length > 0 ? body.wifiSsid : undefined;
    const wifiKey = typeof body.wifiKey === 'string' && body.wifiKey.length > 0 ? body.wifiKey : undefined;

    if (!deviceType || !version || !fleetName) {
      res
        .status(406)
        .json({ success: false, message: 'Request is lacking deviceType, version or fleetName in body context' });
      return;
    }
    if (!VARIANTS.includes(variant as OsImageVariant)) {
      res.status(406).json({ success: false, message: 'Request has an invalid variant in body context' });
      return;
    }
    if (!FORMATS.includes(format as OsImageFormat)) {
      res.status(406).json({ success: false, message: 'Request has an invalid format in body context' });
      return;
    }
    if (!NETWORKS.includes(network as OsImageNetwork)) {
      res.status(406).json({ success: false, message: 'Request has an invalid network in body context' });
      return;
    }
    if (!Number.isInteger(appId) || appId <= 0) {
      res.status(406).json({ success: false, message: 'Request is lacking a valid appId in body context' });
      return;
    }
    if (appUpdatePollInterval !== undefined && (!Number.isFinite(appUpdatePollInterval) || appUpdatePollInterval < 1)) {
      res.status(406).json({ success: false, message: 'Request has an invalid appUpdatePollInterval in body context' });
      return;
    }
    if (network === 'wifi' && !wifiSsid) {
      res.status(406).json({ success: false, message: 'Request is lacking wifiSsid in body context' });
      return;
    }

    const request: PrepareOsImageRequest = {
      deviceType,
      version,
      variant: variant as OsImageVariant,
      format: format as OsImageFormat,
      appId,
      fleetName,
      network: network as OsImageNetwork,
      ...(appUpdatePollInterval !== undefined ? { appUpdatePollInterval } : {}),
      ...(wifiSsid !== undefined ? { wifiSsid } : {}),
      ...(wifiKey !== undefined ? { wifiKey } : {}),
    };

    const job = createOsImageJob(request, req.headers.authorization);
    res.status(200).json({ jobId: job.jobId });
  },
);

router.get<{ id: string }, OsJobResponse | ErrorResponse>('/jobs/:id', ...dosProtect, authorize, (req, res) => {
  const job = getOsImageJob(req.params.id);

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
    const job = getOsImageJob(req.params.id);

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
    createReadStream(artifactPath).pipe(res);
  },
);

export default router;

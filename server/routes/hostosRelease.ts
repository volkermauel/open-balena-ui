import { json, Request, Response, Router } from 'express';
import authorize from '../middleware/authorize';
import dosProtect from '../middleware/dosProtect';
import { hostosSourceRepo } from '../controller/hostosRelease/catalog';
import {
  HostosNotConfiguredError,
  InstanceApiError,
  NotFoundError,
  RegistryMirrorError,
  UpstreamError,
} from '../controller/hostosRelease/errors';
import { resolveHostosVersionsForDeviceType, seedHostosRelease } from '../controller/hostosRelease/seed';

interface ErrorResponse {
  success: false;
  message: string;
}

interface HostosVersionEntryResponse {
  version: string;
  rawVersion: string;
  seeded: boolean;
  releaseId?: number;
  parsable: boolean;
}

interface VersionsSuccessResponse {
  success: true;
  deviceType: string;
  machine: string;
  versions: HostosVersionEntryResponse[];
  sourceRepo: string;
}

interface SeedSuccessResponse {
  success: true;
  appId: number;
  releaseId: number;
  image: { repo: string; digest: string };
}

interface SeedRequestBody {
  deviceType?: string;
  version?: string;
}

const router = Router();

router.use(json());

const callerAuth = (req: Request) => ({ authorization: req.headers.authorization ?? '' });

const sendError = (res: Response, error: unknown): void => {
  if (error instanceof HostosNotConfiguredError) {
    res.status(503).json({ success: false, message: error.message });
    return;
  }
  if (error instanceof UpstreamError) {
    res.status(502).json({ success: false, message: error.message });
    return;
  }
  if (error instanceof InstanceApiError) {
    res.status(error.status >= 400 && error.status < 500 ? error.status : 502).json({
      success: false,
      message: error.message,
    });
    return;
  }
  if (error instanceof RegistryMirrorError) {
    res.status(502).json({ success: false, message: error.message });
    return;
  }
  if (error instanceof NotFoundError) {
    res.status(404).json({ success: false, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'HostOS release operation failed';
  res.status(400).json({ success: false, message });
};

const wrap = (handler: (req: Request, res: Response) => Promise<void>) => {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
};

/**
 * GET /hostos-releases/versions?deviceType=<slug>
 * HostOS versions available in the ghcr mirror for the device type's machine,
 * newest first, annotated with whether each is already imported.
 */
router.get<Record<string, never>, VersionsSuccessResponse | ErrorResponse>(
  '/versions',
  ...dosProtect,
  authorize,
  wrap(async (req, res) => {
    const deviceType = String(req.query.deviceType ?? '');
    if (!deviceType) {
      res.status(406).json({ success: false, message: 'Request is lacking deviceType in query context' });
      return;
    }

    const { deviceType: typeInfo, versions } = await resolveHostosVersionsForDeviceType(callerAuth(req), deviceType);

    res.status(200).json({
      success: true,
      deviceType: typeInfo.slug,
      machine: typeInfo.slug,
      versions: versions.map((entry) => ({
        version: entry.version,
        rawVersion: entry.tag,
        seeded: entry.seeded,
        parsable: entry.parsable,
        ...(entry.releaseId !== undefined ? { releaseId: entry.releaseId } : {}),
      })),
      sourceRepo: hostosSourceRepo(),
    });
  }),
);

/**
 * POST /hostos-releases/seed { deviceType, version }
 * Idempotently import a hostOS version into the instance (image metadata,
 * mirrored bytes, release on the hostapp app, release_image link, version tag).
 */
router.post<Record<string, never>, SeedSuccessResponse | ErrorResponse, SeedRequestBody>(
  '/seed',
  ...dosProtect,
  authorize,
  wrap(async (req, res) => {
    const { deviceType, version } = req.body ?? {};
    if (!deviceType || !version) {
      res.status(406).json({ success: false, message: 'Request is lacking deviceType/version in body context' });
      return;
    }

    const result = await seedHostosRelease(callerAuth(req), String(deviceType), String(version));
    res.status(200).json({ success: true, ...result });
  }),
);

export default router;

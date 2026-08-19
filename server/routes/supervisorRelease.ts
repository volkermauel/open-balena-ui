import { json, Request, Response, Router } from 'express';
import authorize from '../middleware/authorize';
import dosProtect from '../middleware/dosProtect';
import { CatalogVersion, supervisorAppSlug } from '../controller/supervisorRelease/cloud';
import {
  InstanceApiError,
  NotFoundError,
  RegistryMirrorError,
  UpstreamError,
} from '../controller/supervisorRelease/errors';
import {
  DeviceSupervisorState,
  findAppReleases,
  findApplicationBySlug,
  getDeviceSupervisorState,
  InstanceAuth,
  listDeviceTypeArches,
} from '../controller/supervisorRelease/instance';
import {
  resolveCatalogForArch,
  resolveCatalogForDeviceType,
  seedSupervisorRelease,
  seedSupervisorReleaseForArch,
} from '../controller/supervisorRelease/seed';
import { DeviceUpdateResult, updateSupervisorReleases } from '../controller/supervisorRelease/update';

interface ErrorResponse {
  success: false;
  message: string;
}

interface SupervisorVersionEntry {
  version: string;
  rawVersion: string;
  seeded: boolean;
  releaseId?: number;
}

interface VersionsSuccessResponse {
  success: true;
  /** Only set when the listing was resolved from a device type. */
  deviceType?: string;
  arch: string;
  versions: SupervisorVersionEntry[];
}

interface ArchesSuccessResponse {
  success: true;
  arches: string[];
}

interface StatusSuccessResponse {
  success: true;
  current: string | null;
  targetReleaseId: number | null;
  targetVersion: string | null;
  pending: boolean;
}

interface SeedSuccessResponse {
  success: true;
  appId: number;
  releaseId: number;
  images: { repo: string; digest: string }[];
}

interface UpdateSuccessResponse {
  success: true;
  results: DeviceUpdateResult[];
}

/** Arch slug shape accepted for arch-keyed supervisor operations. */
const isArchSlug = (value: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(value);

interface SeedRequestBody {
  /** Arch to seed for — preferred over deviceType (the supervisor is arch-scoped). */
  arch?: string;
  deviceType?: string;
  version?: string;
}

interface UpdateRequestBody extends SeedRequestBody {
  deviceIds?: number[];
}

const router = Router();

router.use(json());

const callerAuth = (req: Request): InstanceAuth => ({ authorization: req.headers.authorization ?? '' });

const sendError = (res: Response, error: unknown): void => {
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
  const message = error instanceof Error ? error.message : 'Supervisor release operation failed';
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
 * GET /supervisor-releases/versions?arch=<slug> | ?deviceType=<slug>
 * Supervisor versions for a CPU arch (or a device type's arch), newest first,
 * annotated with whether each is already seeded into the instance. The
 * supervisor depends only on the architecture, so `arch` is the canonical key.
 */
router.get<Record<string, never>, VersionsSuccessResponse | ErrorResponse>(
  '/versions',
  ...dosProtect,
  authorize,
  wrap(async (req, res) => {
    const deviceType = String(req.query.deviceType ?? '');
    const arch = String(req.query.arch ?? '');
    if (!arch && !deviceType) {
      res.status(406).json({ success: false, message: 'Request is lacking arch/deviceType in query context' });
      return;
    }

    const auth = callerAuth(req);
    let resolvedArch: string;
    let versions: CatalogVersion[];
    let resolvedFrom: string | undefined;
    if (arch) {
      if (!isArchSlug(arch)) {
        res.status(400).json({ success: false, message: `Invalid CPU architecture: ${arch}` });
        return;
      }
      resolvedArch = arch;
      versions = await resolveCatalogForArch(arch);
    } else {
      const resolved = await resolveCatalogForDeviceType(auth, deviceType);
      resolvedArch = resolved.deviceType.arch;
      versions = resolved.versions;
      resolvedFrom = resolved.deviceType.slug;
    }

    // Merge with instance state: an existing supervisor app release marks the version seeded.
    const app = await findApplicationBySlug(auth, supervisorAppSlug(resolvedArch));
    const instanceReleases = app ? await findAppReleases(auth, app.id) : [];

    const seededByRaw = new Map(instanceReleases.map((release) => [release.rawVersion, release.id]));
    const seededBySemver = new Map(instanceReleases.map((release) => [release.semver ?? '', release.id]));

    const entries: SupervisorVersionEntry[] = versions.map((entry: CatalogVersion) => {
      const releaseId = seededByRaw.get(entry.rawVersion) ?? seededBySemver.get(entry.semver);
      return {
        version: entry.semver,
        rawVersion: entry.rawVersion,
        seeded: releaseId !== undefined,
        ...(releaseId !== undefined ? { releaseId } : {}),
      };
    });

    res.status(200).json({
      success: true,
      ...(resolvedFrom !== undefined ? { deviceType: resolvedFrom } : {}),
      arch: resolvedArch,
      versions: entries,
    });
  }),
);

/**
 * GET /supervisor-releases/arches
 * Distinct CPU architectures across the instance's device types — the arch
 * picker of the arch-scoped supervisor import dialog.
 */
router.get<Record<string, never>, ArchesSuccessResponse | ErrorResponse>(
  '/arches',
  ...dosProtect,
  authorize,
  wrap(async (req, res) => {
    const arches = await listDeviceTypeArches(callerAuth(req));
    res.status(200).json({ success: true, arches });
  }),
);

/**
 * GET /supervisor-releases/status?deviceId=<id>
 * Current and target (pending) supervisor release of a device.
 */
router.get<Record<string, never>, StatusSuccessResponse | ErrorResponse>(
  '/status',
  ...dosProtect,
  authorize,
  wrap(async (req, res) => {
    const deviceId = Number(req.query.deviceId);
    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      res.status(406).json({ success: false, message: 'Request is lacking a valid deviceId in query context' });
      return;
    }

    const state: DeviceSupervisorState = await getDeviceSupervisorState(callerAuth(req), deviceId);

    res.status(200).json({
      success: true,
      current: state.current,
      targetReleaseId: state.targetReleaseId,
      targetVersion: state.targetSemver,
      pending: Boolean(state.targetReleaseId) && state.current !== null && state.targetSemver !== state.current,
    });
  }),
);

/**
 * POST /supervisor-releases/seed { arch, version } | { deviceType, version }
 * Idempotently seed a supervisor version into the instance for a CPU arch —
 * one supervisor application and one registry repo per arch, independent of
 * any device make/model.
 */
router.post<Record<string, never>, SeedSuccessResponse | ErrorResponse, SeedRequestBody>(
  '/seed',
  ...dosProtect,
  authorize,
  wrap(async (req, res) => {
    const { arch, deviceType, version } = req.body ?? {};
    if (!(arch || deviceType) || !version) {
      res.status(406).json({ success: false, message: 'Request is lacking arch/deviceType/version in body context' });
      return;
    }

    const auth = callerAuth(req);
    if (arch !== undefined && arch !== '') {
      if (!isArchSlug(arch)) {
        res.status(400).json({ success: false, message: `Invalid CPU architecture: ${arch}` });
        return;
      }
      const result = await seedSupervisorReleaseForArch(auth, arch, String(version));
      res.status(200).json({ success: true, ...result });
      return;
    }

    const result = await seedSupervisorRelease(auth, String(deviceType), String(version));
    res.status(200).json({ success: true, ...result });
  }),
);

/**
 * POST /supervisor-releases/update { deviceType, version, deviceIds: number[] }
 * Ensure seeded, then set the target supervisor release per device; reports
 * per-device results (bulk tolerates partial failure).
 */
router.post<Record<string, never>, UpdateSuccessResponse | ErrorResponse, UpdateRequestBody>(
  '/update',
  ...dosProtect,
  authorize,
  wrap(async (req, res) => {
    const { deviceType, version, deviceIds } = req.body ?? {};
    if (!deviceType || !version || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      res.status(406).json({
        success: false,
        message: 'Request is lacking deviceType/version/deviceIds in body context',
      });
      return;
    }

    if (!deviceIds.every((id) => Number.isInteger(id) && (id as number) > 0)) {
      res.status(406).json({ success: false, message: 'deviceIds must be positive integers' });
      return;
    }

    const outcome = await updateSupervisorReleases(
      callerAuth(req),
      String(deviceType),
      String(version),
      deviceIds as number[],
    );

    res.status(200).json({ success: true, results: outcome.results });
  }),
);

export default router;

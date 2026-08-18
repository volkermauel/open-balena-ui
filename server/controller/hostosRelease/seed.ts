import {
  fetchHostosTagDigest,
  fetchHostosTags,
  hostappApplicationSlug,
  hostosSource,
  hostosSourceRegistryConfig,
  hostosTargetRepo,
  HostosVersion,
  machineForDeviceType,
  orderHostosTags,
  sourceRepo,
} from './catalog';
import { NotFoundError, UpstreamError } from './errors';
import { createHostosRelease, createReleaseTag, findAppService, hasReleaseTag, hostosCommit } from './instance';
import {
  createImage,
  createReleaseImage,
  DeviceTypeInfo,
  findAppReleases,
  findApplicationBySlug,
  findImageByContentHash,
  findReleaseImages,
  getDeviceTypeBySlug,
  getImageLocation,
  InstanceAuth,
  parseSemverFields,
} from '../supervisorRelease/instance';
import { mirrorImageFromSource, targetRegistryHost, verifyManifestAtTarget } from '../supervisorRelease/registryMirror';
import { repoFromLocation } from '../supervisorRelease/seed';

/**
 * Idempotent import of a hostOS version into the instance, in a crash-safe
 * order that never exposes a release referencing un-mirrored image bytes:
 *
 * image METADATA (instance location) → MIRROR bytes → (verify at target) →
 * release on the device type's hostapp app → release_image link →
 * `version` release tag (makes it appear in the Target-OS selector).
 *
 * Unlike supervisor seeding there is no app/service creation: the hostapp app
 * (`admin/<slug>`) and its service already exist on the instance.
 */

export interface HostosSeedResult {
  appId: number;
  releaseId: number;
  image: { repo: string; digest: string };
}

export type HostosSeedStep =
  | 'create-image-metadata'
  | 'mirror-bytes'
  | 'create-release'
  | 'create-release-image'
  | 'create-release-tag'
  | 'complete';

export interface HostosSeedExistingState {
  appId?: number;
  serviceId?: number;
  imageId?: number;
  releaseId?: number;
  linkedImageIds: number[];
  hasVersionTag: boolean;
  bytesVerified: boolean;
}

/**
 * Pure decision of which import steps remain, given the existing instance
 * state (a hostOS version is exactly one image). Unit tested — the imperative
 * seed below follows exactly this order.
 *
 * The release and its image link are created BEFORE mirroring: the API's
 * registry-token endpoint grants `pull` on a repo only once its image is
 * linked to a release (application → release → release_image → image), so
 * mirroring first would yield a push-only token and every read-back HEAD
 * at the target registry would fail with 401.
 */
export const planHostosSeedSteps = (existing: HostosSeedExistingState): HostosSeedStep[] => {
  const steps: HostosSeedStep[] = [];

  if (!existing.imageId) {
    steps.push('create-image-metadata');
  }
  if (!existing.releaseId) {
    steps.push('create-release');
  }
  if (!existing.releaseId || existing.linkedImageIds.length < 1) {
    steps.push('create-release-image');
  }
  if (!existing.bytesVerified) {
    steps.push('mirror-bytes');
  }
  if (!existing.releaseId || !existing.hasVersionTag) {
    steps.push('create-release-tag');
  }
  if (steps.length === 0) {
    steps.push('complete');
  }

  return steps;
};

// Per-deviceType in-process lock: concurrent imports of the same device type
// serialize (first one creates the rows; a re-import reuses them), preventing
// duplicate-release races.
const seedLocks = new Map<string, Promise<unknown>>();

const withSeedLock = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const tail = (seedLocks.get(key) ?? Promise.resolve()) as Promise<unknown>;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  seedLocks.set(
    key,
    tail.then(() => gate),
  );

  await tail;
  try {
    return await work();
  } finally {
    release();
  }
};

export interface HostosVersionEntry {
  tag: string;
  version: string;
  seeded: boolean;
  releaseId?: number;
  parsable: boolean;
}

/**
 * List the hostOS versions available in the mirror for a device type,
 * newest-first, annotated with whether each version is already imported
 * (a matching release exists on the device type's hostapp app).
 */
export const resolveHostosVersionsForDeviceType = async (
  auth: InstanceAuth,
  deviceTypeSlug: string,
): Promise<{ deviceType: DeviceTypeInfo; versions: HostosVersionEntry[] }> => {
  const deviceType = await getDeviceTypeBySlug(auth, deviceTypeSlug);
  const machine = machineForDeviceType(deviceType.slug);
  const catalog = orderHostosTags(await fetchHostosTags(machine));

  const app = await findApplicationBySlug(auth, hostappApplicationSlug(deviceType.slug));
  const instanceReleases = app ? await findAppReleases(auth, app.id) : [];

  const seededByRaw = new Map(instanceReleases.map((release) => [release.rawVersion, release.id]));
  const seededBySemver = new Map(instanceReleases.map((release) => [release.semver ?? '', release.id]));

  const versions: HostosVersionEntry[] = catalog.map((entry: HostosVersion) => {
    const releaseId = seededByRaw.get(entry.tag) ?? seededBySemver.get(entry.version);
    return {
      tag: entry.tag,
      version: entry.version,
      parsable: entry.parsable,
      seeded: releaseId !== undefined,
      ...(releaseId !== undefined ? { releaseId } : {}),
    };
  });

  return { deviceType, versions };
};

/** Guard used by the plan executor below: a planned step must have produced the id. */
const requireSeedId = (id: number | undefined, what: string): number => {
  if (id === undefined) {
    throw new UpstreamError(`Seed plan error: ${what} id missing after planned steps`);
  }
  return id;
};

/**
 * Import (or confirm already imported) a hostOS version for a device type and
 * return the instance release id. `version` is the parsed balenaOS version
 * shown by `resolveHostosVersionsForDeviceType` (e.g. `7.4.0+rev5`).
 */
export const seedHostosRelease = async (
  auth: InstanceAuth,
  deviceTypeSlug: string,
  version: string,
): Promise<HostosSeedResult> => {
  const deviceType = await getDeviceTypeBySlug(auth, deviceTypeSlug);
  return withSeedLock(deviceType.slug, async () => {
    const { authorization } = auth;
    const machine = machineForDeviceType(deviceType.slug);

    // Mirror catalog for this version (before touching the instance).
    const catalog = orderHostosTags(await fetchHostosTags(machine)).find(
      (entry) => entry.parsable && entry.version === version,
    );
    if (!catalog) {
      throw new NotFoundError(`Unknown hostOS version ${version} for device type ${deviceTypeSlug}`);
    }
    const digest = await fetchHostosTagDigest(machine, catalog.tag);

    // Existing instance state — lookups only; every creation happens per the plan below.
    const hostappSlug = hostappApplicationSlug(deviceType.slug);
    const app = await findApplicationBySlug(auth, hostappSlug);
    if (!app) {
      throw new NotFoundError(`No hostapp application ${hostappSlug} on the instance — hostOS releases attach to it`);
    }
    const service = await findAppService(auth, app.id);
    if (!service) {
      throw new NotFoundError(`Hostapp application ${hostappSlug} has no service to attach the image to`);
    }

    const existingReleases = await findAppReleases(auth, app.id);
    const existingRelease = existingReleases.find(
      (release) => release.rawVersion === catalog.tag || release.semver === catalog.version,
    );

    const existingImage = await findImageByContentHash(auth, digest);
    const imageId = existingImage && existingImage.serviceId === service.id ? existingImage.id : undefined;

    // Target repo: whatever the instance actually stores for this image. The
    // API may assign a server-side location on create (the
    // image-is-stored-at-location hook overwrites the posted value), so bytes
    // are always mirrored into the row's real repo — never an assumed one.
    let repo = imageId !== undefined && existingImage?.location ? repoFromLocation(existingImage.location) : undefined;
    const bytesVerified = repo !== undefined && (await verifyManifestAtTarget(repo, digest, authorization));
    const linkedImageIds = existingRelease
      ? (await findReleaseImages(auth, existingRelease.id)).map((link) => link.imageId)
      : [];
    const hasVersionTag = existingRelease
      ? await hasReleaseTag(auth, existingRelease.id, 'version', catalog.version)
      : false;

    // The pure planner (unit tested) decides which steps remain; execution
    // follows it exactly, in its order — the tested order IS the real order.
    const plan = planHostosSeedSteps({
      appId: app.id,
      serviceId: service.id,
      imageId,
      releaseId: existingRelease?.id,
      linkedImageIds,
      hasVersionTag,
      bytesVerified,
    });

    let releaseId = existingRelease?.id;
    let createdImageId = imageId;

    for (const step of plan) {
      switch (step) {
        case 'create-image-metadata': {
          const location = `${targetRegistryHost()}/v2/${hostosTargetRepo(machine)}`;
          const created = await createImage(auth, service.id, location, digest);
          createdImageId = created.id;
          // The hook may overwrite the posted location — read back what stuck.
          repo = repoFromLocation(await getImageLocation(auth, created.id));
          break;
        }
        case 'mirror-bytes': {
          if (repo === undefined) {
            throw new UpstreamError('Seed plan error: target repo unknown before mirroring');
          }
          await mirrorImageFromSource(
            authorization,
            sourceRepo(hostosSource(), machine),
            digest,
            hostosSourceRegistryConfig(hostosSource()),
            repo,
          );
          if (!(await verifyManifestAtTarget(repo, digest, authorization))) {
            throw new UpstreamError(`Mirroring of hostOS ${version} did not verify at the target registry`);
          }
          break;
        }
        case 'create-release':
          releaseId = (
            await createHostosRelease(auth, {
              appId: requireSeedId(app.id, 'hostapp application'),
              commit: hostosCommit(machine, catalog.tag),
              rawVersion: catalog.tag,
              version: catalog.version,
              semver: parseSemverFields(catalog.version),
              composition: {},
            })
          ).id;
          break;
        case 'create-release-image': {
          const release = requireSeedId(releaseId, 'release');
          const image = requireSeedId(createdImageId, 'image');
          if (!linkedImageIds.includes(image)) {
            await createReleaseImage(auth, release, image);
          }
          break;
        }
        case 'create-release-tag':
          await createReleaseTag(auth, requireSeedId(releaseId, 'release'), 'version', catalog.version);
          break;
        case 'complete':
          break;
      }
    }

    return {
      appId: app.id,
      releaseId: requireSeedId(releaseId, 'release'),
      image: { repo: repo ?? hostosTargetRepo(machine), digest },
    };
  });
};

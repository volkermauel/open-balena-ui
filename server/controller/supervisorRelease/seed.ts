import {
  CatalogVersion,
  fetchCloudReleaseComposition,
  listMirrorVersions,
  serviceNameForVersion,
  supervisorAppSlug,
} from './cloud';
import { NotFoundError, SupervisorTagMissingError, UpstreamError } from './errors';
import {
  commitForCloudRelease,
  createImage,
  createRelease,
  getImageLocation,
  createReleaseImage,
  createService,
  createSupervisorApplication,
  DeviceTypeInfo,
  findAppReleases,
  findApplicationBySlug,
  findDeviceTypeByArch,
  findImageByContentHash,
  findReleaseImages,
  findServiceByName,
  getDeviceTypeBySlug,
  InstanceAuth,
  parseSemverFields,
} from './instance';
import {
  mirrorImageFromSource,
  resolveTagDigest,
  supervisorSourceRegistry,
  supervisorSourceRepo,
  supervisorTargetRepo,
  targetRegistryHost,
  verifyManifestAtTarget,
} from './registryMirror';

/**
 * Idempotent seeding of a supervisor version into the instance, in a
 * crash-safe order that never exposes a release referencing un-mirrored
 * images:
 *
 * app → services → image METADATA (instance location) → MIRROR bytes →
 * (verify manifest at target) → release → release_image links.
 *
 * The image comes from the configured ghcr-style mirror: its manifest digest
 * (resolved by tag on the mirror) is the image row's content hash — never a
 * balenaCloud digest, the self-built image is not balenaCloud's build.
 */

export interface SeedImageResult {
  repo: string;
  digest: string;
}

export interface SeedResult {
  appId: number;
  releaseId: number;
  images: SeedImageResult[];
}

/** Extract the repository name from a registry image location (`host/v2/<repo>`). */
export const repoFromLocation = (location: string): string => {
  const match = /^[^/]+\/v2\/(.+)$/.exec(location);
  if (!match) {
    throw new UpstreamError(`Unexpected registry image location: ${location}`);
  }
  return match[1];
};

/**
 * A supervisor release carries exactly one image: the mirror's build of the
 * version, identified by the digest resolved from its tag.
 */
interface MirrorImage {
  /** Repository path at the source mirror the bytes are pulled from. */
  sourceRepo: string;
  /** Manifest digest on the mirror — the image row's content hash. */
  digest: string;
  serviceName: string;
}

export type SeedPlanStep =
  | 'create-app'
  | 'create-service'
  | 'create-image-metadata'
  | 'mirror-bytes'
  | 'create-release'
  | 'create-release-image'
  | 'complete';

export interface SeedExistingState {
  appId?: number;
  releaseId?: number;
  existingServiceNames: string[];
  existingImageHashes: string[];
  existingReleaseImageIds: number[];
  /** Whether the existing release already links exactly the current images (digest unchanged). */
  releaseLinksCurrentImages: boolean;
  bytesVerified: boolean;
}

/**
 * Pure decision of which seed steps remain, given the existing instance
 * state and the catalog facts. Unit tested — the imperative seed below
 * follows exactly this order.
 *
 * The release and its image links are created BEFORE mirroring: the API's
 * registry-token endpoint grants `pull` on a repo only once its image is
 * linked to a release (application → release → release_image → image), so
 * mirroring first would yield a push-only token and every read-back HEAD
 * at the target registry would fail with 401.
 */
export const planSeedSteps = (
  existing: SeedExistingState,
  cloud: { serviceNames: string[]; imageHashes: string[]; imageCount: number },
): SeedPlanStep[] => {
  const steps: SeedPlanStep[] = [];

  if (!existing.appId) {
    steps.push('create-app');
  }
  if (cloud.serviceNames.some((name) => !existing.existingServiceNames.includes(name))) {
    steps.push('create-service');
  }
  if (cloud.imageHashes.some((hash) => !existing.existingImageHashes.includes(hash))) {
    steps.push('create-image-metadata');
  }
  if (!existing.releaseId) {
    steps.push('create-release');
  }
  if (
    !existing.releaseId ||
    existing.existingReleaseImageIds.length < cloud.imageCount ||
    !existing.releaseLinksCurrentImages
  ) {
    steps.push('create-release-image');
  }
  if (!existing.bytesVerified) {
    steps.push('mirror-bytes');
  }
  if (steps.length === 0) {
    steps.push('complete');
  }

  return steps;
};

// Per-arch in-process lock: concurrent seeds serialize (first one creates the
// app row; later ones — any version — reuse it), preventing duplicate-app races.
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

/** Resolve device type + arch and the mirror catalog for a version listing. */
export const resolveCatalogForDeviceType = async (
  auth: InstanceAuth,
  deviceTypeSlug: string,
): Promise<{ deviceType: DeviceTypeInfo; versions: CatalogVersion[] }> => {
  const deviceType = await getDeviceTypeBySlug(auth, deviceTypeSlug);
  return { deviceType, versions: await listMirrorVersions(deviceType.arch) };
};

/**
 * Seed (or confirm already seeded) a supervisor version for a device type's
 * arch and return the instance release id.
 */
/** Guard used by the plan executor below: a planned step must have produced the id. */
const requireSeedId = (id: number | undefined, what: string): number => {
  if (id === undefined) {
    throw new UpstreamError(`Seed plan error: ${what} id missing after planned steps`);
  }
  return id;
};

/** Release composition from the balenaCloud catalog when known; `{}` otherwise. Best-effort. */
const compositionForVersion = async (catalog: CatalogVersion): Promise<unknown> => {
  if (!catalog.cloudReleaseId) {
    return {};
  }
  try {
    return await fetchCloudReleaseComposition(catalog.cloudReleaseId);
  } catch {
    return {};
  }
};

export const seedSupervisorRelease = async (
  auth: InstanceAuth,
  deviceTypeSlug: string,
  version: string,
): Promise<SeedResult> => {
  const { deviceType } = await resolveCatalogForDeviceType(auth, deviceTypeSlug);
  return withSeedLock(deviceType.arch, async () => {
    const { authorization } = auth;
    const arch = deviceType.arch;
    const slug = supervisorAppSlug(arch);

    // Mirror catalog for this version (before touching the instance)
    const source = supervisorSourceRegistry();
    const sourceRepo = supervisorSourceRepo(arch);
    // The catalog stores semvers without the `v` prefix; accept both spellings.
    const normalizedVersion = version.replace(/^v/, '');
    const catalog = (await listMirrorVersions(arch)).find((entry) => entry.semver === normalizedVersion);
    if (!catalog) {
      throw new SupervisorTagMissingError(`version ${version}`, sourceRepo, source.url);
    }
    // The mirror's digest of the tag — the identity of the self-built image.
    const digest = await resolveTagDigest(sourceRepo, catalog.mirrorTag, source);
    const images: MirrorImage[] = [{ sourceRepo, digest, serviceName: await serviceNameForVersion(catalog) }];

    // Existing instance state — lookups only; every creation happens per the plan below.
    let app = await findApplicationBySlug(auth, slug);
    const existingReleases = app ? await findAppReleases(auth, app.id) : [];
    const existingRelease = existingReleases.find(
      (release) => release.rawVersion === catalog.rawVersion || release.semver === catalog.semver,
    );

    const serviceNames = [...new Set(images.map((image) => image.serviceName))];
    const serviceIds = new Map<string, number>();
    const existingServiceNames: string[] = [];
    for (const serviceName of serviceNames) {
      const existingService = app ? await findServiceByName(auth, app.id, serviceName) : undefined;
      if (existingService) {
        serviceIds.set(serviceName, existingService.id);
        existingServiceNames.push(serviceName);
      }
    }

    const registryHost = targetRegistryHost();
    const imageIdByHash = new Map<string, number>();
    // Target repo per image: the instance may assign locations server-side on
    // create (image-is-stored-at-location hook), so the row's stored location
    // is the only source of truth for where bytes must be mirrored to.
    const targetRepoByHash = new Map<string, string>();
    const existingImageHashes: string[] = [];
    for (const image of images) {
      if (imageIdByHash.has(image.digest)) {
        continue;
      }
      const existingImage = await findImageByContentHash(auth, image.digest);
      if (existingImage && existingServiceMatch(existingImage.serviceId, serviceIds)) {
        imageIdByHash.set(image.digest, existingImage.id);
        targetRepoByHash.set(image.digest, repoFromLocation(existingImage.location));
        existingImageHashes.push(image.digest);
      }
    }

    /** Target repo of an image row; a missing entry means the plan order was violated. */
    const targetRepoFor = (hash: string): string => {
      const repo = targetRepoByHash.get(hash);
      if (!repo) {
        throw new UpstreamError(`Seed plan error: target repo unknown for image ${hash}`);
      }
      return repo;
    };

    const verifyAll = async (): Promise<boolean> => {
      if (images.some((image) => !targetRepoByHash.has(image.digest))) {
        return false; // an image without a row has no mirrored location yet
      }
      const results = await Promise.all(
        images.map(async (image) => verifyManifestAtTarget(targetRepoFor(image.digest), image.digest, authorization)),
      );
      return results.every((ok) => ok);
    };

    const existingReleaseImageIds = existingRelease
      ? (await findReleaseImages(auth, existingRelease.id)).map((link) => link.imageId)
      : [];

    // A digest change: the existing release links images other than the ones
    // this seed resolves to (an image without a row yet can never be linked),
    // so the new image must be linked into the existing release after mirroring.
    const releaseLinksCurrentImages =
      existingReleaseImageIds.length === images.length &&
      images.every((image) => {
        const imageId = imageIdByHash.get(image.digest);
        return imageId !== undefined && existingReleaseImageIds.includes(imageId);
      });

    // The pure planner (unit tested) decides which steps remain; execution
    // follows it exactly, in its order — the tested order IS the real order.
    const plan = planSeedSteps(
      {
        appId: app?.id,
        releaseId: existingRelease?.id,
        existingServiceNames,
        existingImageHashes,
        existingReleaseImageIds,
        releaseLinksCurrentImages,
        bytesVerified: await verifyAll(),
      },
      {
        serviceNames,
        imageHashes: images.map((image) => image.digest),
        imageCount: images.length,
      },
    );

    let appId = app?.id;
    let releaseId = existingRelease?.id;

    for (const step of plan) {
      switch (step) {
        case 'create-app': {
          const instanceDeviceType = await findDeviceTypeByArch(auth, arch);
          app = await createSupervisorApplication(auth, arch, instanceDeviceType.id);
          appId = app.id;
          break;
        }
        case 'create-service':
          for (const serviceName of serviceNames) {
            if (!serviceIds.has(serviceName)) {
              serviceIds.set(
                serviceName,
                (await createService(auth, requireSeedId(appId, 'application'), serviceName)).id,
              );
            }
          }
          break;
        case 'create-image-metadata':
          for (const image of images) {
            if (imageIdByHash.has(image.digest)) {
              continue;
            }
            const serviceId = serviceIds.get(image.serviceName);
            if (!serviceId) {
              throw new NotFoundError(`No service ${image.serviceName} for image ${image.sourceRepo}`);
            }
            const location = `${registryHost}/v2/${supervisorTargetRepo(arch)}`;
            const created = await createImage(auth, serviceId, location, image.digest);
            imageIdByHash.set(image.digest, created.id);
            // The hook may overwrite the posted location — read back what stuck.
            targetRepoByHash.set(image.digest, repoFromLocation(await getImageLocation(auth, created.id)));
          }
          break;
        case 'mirror-bytes':
          for (const image of images) {
            await mirrorImageFromSource(
              authorization,
              image.sourceRepo,
              image.digest,
              source,
              targetRepoFor(image.digest),
            );
          }
          if (!(await verifyAll())) {
            throw new UpstreamError(`Mirroring of supervisor ${version} did not verify at the target registry`);
          }
          break;
        case 'create-release':
          releaseId = (
            await createRelease(auth, {
              appId: requireSeedId(appId, 'application'),
              commit: commitForCloudRelease(catalog.cloudReleaseId, catalog.rawVersion),
              rawVersion: catalog.rawVersion,
              semver: parseSemverFields(catalog.semver),
              composition: await compositionForVersion(catalog),
            })
          ).id;
          break;
        case 'create-release-image': {
          const release = requireSeedId(releaseId, 'release');
          const linkedImageIds = new Set((await findReleaseImages(auth, release)).map((link) => link.imageId));
          for (const image of images) {
            const imageId = imageIdByHash.get(image.digest);
            if (imageId !== undefined && !linkedImageIds.has(imageId)) {
              await createReleaseImage(auth, release, imageId);
            }
          }
          break;
        }
        case 'complete':
          break;
      }
    }

    return {
      appId: requireSeedId(appId, 'application'),
      releaseId: requireSeedId(releaseId, 'release'),
      images: images.map((image) => ({ repo: targetRepoFor(image.digest), digest: image.digest })),
    };
  });
};

const existingServiceMatch = (serviceId: number, serviceIds: Map<string, number>): boolean =>
  [...serviceIds.values()].includes(serviceId);

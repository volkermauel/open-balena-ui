import {
  CatalogVersion,
  CloudReleaseImage,
  dedupeAndOrderReleases,
  fetchCloudReleaseComposition,
  fetchReleaseImages,
  fetchSupervisorApplication,
  fetchSupervisorReleases,
  supervisorAppSlug,
} from './cloud';
import { NotFoundError, UpstreamError } from './errors';
import {
  commitForCloudRelease,
  createImage,
  createRelease,
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
import { mirrorImage, targetRegistryHost, verifyManifestAtTarget } from './registryMirror';

/**
 * Idempotent seeding of a supervisor version into the instance, in a
 * crash-safe order that never exposes a release referencing un-mirrored
 * images:
 *
 * app → services → image METADATA (instance location) → MIRROR bytes →
 * (verify manifest at target) → release → release_image links.
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
    throw new UpstreamError(`Unexpected balenaCloud image location: ${location}`);
  }
  return match[1];
};

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
  bytesVerified: boolean;
}

/**
 * Pure decision of which seed steps remain, given the existing instance
 * state and the cloud catalog facts. Unit tested — the imperative seed below
 * follows exactly this order.
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
  if (!existing.bytesVerified) {
    steps.push('mirror-bytes');
  }
  if (!existing.releaseId) {
    steps.push('create-release');
  }
  if (!existing.releaseId || existing.existingReleaseImageIds.length < cloud.imageCount) {
    steps.push('create-release-image');
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

/** Resolve device type + arch and the cloud catalog for a version listing. */
export const resolveCatalogForDeviceType = async (
  auth: InstanceAuth,
  deviceTypeSlug: string,
): Promise<{ deviceType: DeviceTypeInfo; applicationId: number; versions: CatalogVersion[] }> => {
  const deviceType = await getDeviceTypeBySlug(auth, deviceTypeSlug);

  const application = await fetchSupervisorApplication(deviceType.arch);
  if (!application) {
    throw new NotFoundError(`balenaCloud has no supervisor application for arch ${deviceType.arch}`);
  }

  const releases = await fetchSupervisorReleases(application.id);
  return { deviceType, applicationId: application.id, versions: dedupeAndOrderReleases(releases) };
};

/** Fetch the cloud images of a specific catalog version. */
export const fetchCloudImagesForVersion = async (
  versions: CatalogVersion[],
  version: string,
): Promise<{ catalog: CatalogVersion; images: CloudReleaseImage[] }> => {
  const catalog = versions.find((entry) => entry.semver === version);
  if (!catalog) {
    throw new NotFoundError(`Unknown supervisor version ${version} for this device type`);
  }

  const images = await fetchReleaseImages(catalog.cloudReleaseId);
  if (images.length === 0) {
    throw new NotFoundError(`Supervisor version ${version} has no images in the balenaCloud catalog`);
  }

  return { catalog, images };
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

    // Cloud catalog for this version (before touching the instance)
    const cloudApp = await fetchSupervisorApplication(arch);
    if (!cloudApp) {
      throw new NotFoundError(`balenaCloud has no supervisor application for arch ${arch}`);
    }
    const versions = dedupeAndOrderReleases(await fetchSupervisorReleases(cloudApp.id));
    const { catalog, images } = await fetchCloudImagesForVersion(versions, version);

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
    const existingImageHashes: string[] = [];
    for (const image of images) {
      if (imageIdByHash.has(image.contentHash)) {
        continue;
      }
      const existingImage = await findImageByContentHash(auth, image.contentHash);
      if (existingImage && existingServiceMatch(existingImage.serviceId, serviceIds)) {
        imageIdByHash.set(image.contentHash, existingImage.id);
        existingImageHashes.push(image.contentHash);
      }
    }

    const verifyAll = async (): Promise<boolean> => {
      const results = await Promise.all(
        images.map(async (image) =>
          verifyManifestAtTarget(repoFromLocation(image.location), image.contentHash, authorization),
        ),
      );
      return results.every((ok) => ok);
    };

    const existingReleaseImageIds = existingRelease
      ? (await findReleaseImages(auth, existingRelease.id)).map((link) => link.imageId)
      : [];

    // The pure planner (unit tested) decides which steps remain; execution
    // follows it exactly, in its order — the tested order IS the real order.
    const plan = planSeedSteps(
      {
        appId: app?.id,
        releaseId: existingRelease?.id,
        existingServiceNames,
        existingImageHashes,
        existingReleaseImageIds,
        bytesVerified: await verifyAll(),
      },
      {
        serviceNames,
        imageHashes: images.map((image) => image.contentHash),
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
            if (imageIdByHash.has(image.contentHash)) {
              continue;
            }
            const serviceId = serviceIds.get(image.serviceName);
            if (!serviceId) {
              throw new NotFoundError(`No service ${image.serviceName} for image ${repoFromLocation(image.location)}`);
            }
            const location = `${registryHost}/v2/${repoFromLocation(image.location)}`;
            imageIdByHash.set(image.contentHash, (await createImage(auth, serviceId, location, image.contentHash)).id);
          }
          break;
        case 'mirror-bytes':
          for (const image of images) {
            await mirrorImage(authorization, repoFromLocation(image.location), image.contentHash);
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
              composition: await fetchCloudReleaseComposition(catalog.cloudReleaseId),
            })
          ).id;
          break;
        case 'create-release-image': {
          const release = requireSeedId(releaseId, 'release');
          const linkedImageIds = new Set((await findReleaseImages(auth, release)).map((link) => link.imageId));
          for (const image of images) {
            const imageId = imageIdByHash.get(image.contentHash);
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
      images: images.map((image) => ({ repo: repoFromLocation(image.location), digest: image.contentHash })),
    };
  });
};

const existingServiceMatch = (serviceId: number, serviceIds: Map<string, number>): boolean =>
  [...serviceIds.values()].includes(serviceId);

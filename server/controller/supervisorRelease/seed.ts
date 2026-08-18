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

// Per-(arch, version) in-process lock: concurrent seeds await the first.
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
export const seedSupervisorRelease = async (
  auth: InstanceAuth,
  deviceTypeSlug: string,
  version: string,
): Promise<SeedResult> => {
  const { deviceType } = await resolveCatalogForDeviceType(auth, deviceTypeSlug);
  return withSeedLock(`${deviceType.arch}:${version}`, async () => {
    const { authorization } = auth;
    const arch = deviceType.arch;
    const slug = supervisorAppSlug(arch);

    // 1. Application (idempotent by slug)
    let app = await findApplicationBySlug(auth, slug);
    if (!app) {
      const instanceDeviceType = await findDeviceTypeByArch(auth, arch);
      app = await createSupervisorApplication(auth, arch, instanceDeviceType.id);
    }
    const appId = app.id;

    // 2. Cloud catalog for this version
    const cloudApp = await fetchSupervisorApplication(arch);
    if (!cloudApp) {
      throw new NotFoundError(`balenaCloud has no supervisor application for arch ${arch}`);
    }
    const versions = dedupeAndOrderReleases(await fetchSupervisorReleases(cloudApp.id));
    const { catalog, images } = await fetchCloudImagesForVersion(versions, version);

    // 3. Existing release? (idempotency short-circuit — releases are only
    // created after mirroring, so an existing release means a completed seed)
    const existingReleases = await findAppReleases(auth, appId);
    const existingRelease = existingReleases.find(
      (release) => release.rawVersion === catalog.rawVersion || release.semver === catalog.semver,
    );

    // 4. Services (create-if-missing, same names as balenaCloud)
    const serviceIds = new Map<string, number>();
    for (const serviceName of [...new Set(images.map((image) => image.serviceName))]) {
      const existingService = await findServiceByName(auth, appId, serviceName);
      serviceIds.set(serviceName, existingService?.id ?? (await createService(auth, appId, serviceName)).id);
    }

    // 5. Image metadata (instance-registry location, balenaCloud digest as content hash)
    const registryHost = targetRegistryHost();
    const imageIds: number[] = [];
    const mirroredImages: SeedImageResult[] = [];

    const verifyAll = async (): Promise<boolean> => {
      const results = await Promise.all(
        images.map(async (image) =>
          verifyManifestAtTarget(repoFromLocation(image.location), image.contentHash, authorization),
        ),
      );
      return results.every((ok) => ok);
    };

    for (const image of images) {
      const repo = repoFromLocation(image.location);
      const existingImage = await findImageByContentHash(auth, image.contentHash);

      let imageId = existingImage?.id;
      if (!existingImage || !existingServiceMatch(existingImage.serviceId, serviceIds)) {
        const serviceId = serviceIds.get(image.serviceName);
        if (!serviceId) {
          throw new NotFoundError(`No service ${image.serviceName} for image ${repo}`);
        }
        const location = `${registryHost}/v2/${repo}`;
        imageId = (await createImage(auth, serviceId, location, image.contentHash)).id;
      }
      if (!imageId) {
        throw new NotFoundError(`Could not resolve an image row for ${repo}`);
      }

      imageIds.push(imageId);
      mirroredImages.push({ repo, digest: image.contentHash });
    }

    // 6. Mirror bytes (skip only when every manifest is already at the target)
    const alreadyMirrored = await verifyAll();
    if (!alreadyMirrored) {
      for (const image of images) {
        await mirrorImage(authorization, repoFromLocation(image.location), image.contentHash);
      }
      if (!(await verifyAll())) {
        throw new UpstreamError(`Mirroring of supervisor ${version} did not verify at the target registry`);
      }
    }

    // 7. Release (composition copied verbatim from balenaCloud)
    let releaseId = existingRelease?.id;
    if (!releaseId) {
      releaseId = (
        await createRelease(auth, {
          appId,
          commit: commitForCloudRelease(catalog.cloudReleaseId, catalog.rawVersion),
          rawVersion: catalog.rawVersion,
          semver: parseSemverFields(catalog.semver),
          composition: await fetchCloudReleaseComposition(catalog.cloudReleaseId),
        })
      ).id;
    }

    // 8. release_image links
    const linkedImageIds = new Set((await findReleaseImages(auth, releaseId)).map((link) => link.imageId));
    for (const imageId of imageIds) {
      if (!linkedImageIds.has(imageId)) {
        await createReleaseImage(auth, releaseId, imageId);
      }
    }

    return { appId, releaseId, images: mirroredImages };
  });
};

const existingServiceMatch = (serviceId: number, serviceIds: Map<string, number>): boolean =>
  [...serviceIds.values()].includes(serviceId);

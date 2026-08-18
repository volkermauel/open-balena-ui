import * as balenaSemver from 'balena-semver';
import { UpstreamError } from './errors';

/**
 * Anonymous read-only client for balenaCloud's public supervisor catalog.
 *
 * OData encoding note (verified against api.balena-cloud.com): spaces in the
 * query string are encoded as `%20` exactly once; single quotes, slashes and
 * `$`-prefixed options must stay literal — percent-encoded quotes are rejected
 * with `400 Malformed url`. Only ever interpolate values that passed
 * `isSafeODataToken` below into a filter string.
 */

export const DEFAULT_BALENACLOUD_API_URL = 'https://api.balena-cloud.com';

export const balenaCloudApiUrl = (): string =>
  (process.env.BALENACLOUD_API_URL || DEFAULT_BALENACLOUD_API_URL).replace(/\/+$/, '');

/** BalenaCloud slug of the supervisor fleet application for a CPU arch slug (e.g. `aarch64`). */
export const supervisorAppSlug = (arch: string): string => `balena_os/${arch}-supervisor`;

/** Restricts a value to characters that are safe unencoded inside an OData $filter literal. */
export const isSafeODataToken = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(value);

export interface CloudApplication {
  id: number;
  slug: string;
}

export interface CloudRelease {
  id: number;
  raw_version: string;
  semver: string;
  variant: string;
  composition: unknown;
}

export interface CloudReleaseImage {
  location: string;
  contentHash: string;
  serviceName: string;
}

/** A release after dedupe/ordering, ready for the version listing. */
export interface CatalogVersion {
  semver: string;
  rawVersion: string;
  cloudReleaseId: number;
  variant: string;
}

interface ODataResponse<T> {
  d: T[];
}

interface ExpandedCloudImage {
  is_stored_at__image_location?: string;
  content_hash?: string;
  is_a_build_of__service?: { service_name?: string }[] | { service_name?: string } | null;
}

const asArray = <T>(value: T | T[] | null | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

const readJson = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

const getCloudJson = async <T>(path: string): Promise<T[]> => {
  const res = await fetch(`${balenaCloudApiUrl()}${path}`, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await readJson(res);
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? `: ${String((body as { error: { text?: string } }).error?.text ?? '').slice(0, 200)}`
        : '';
    throw new UpstreamError(`balenaCloud request failed with status ${res.status}${detail}`);
  }

  const body = (await readJson(res)) as ODataResponse<T> | T[] | null;
  if (body == null) {
    return [];
  }
  return Array.isArray(body) ? body : body.d;
};

/** Fetch the public supervisor application for a CPU arch. Returns null when none exists. */
export const fetchSupervisorApplication = async (arch: string): Promise<CloudApplication | null> => {
  if (!isSafeODataToken(arch)) {
    throw new UpstreamError(`Invalid CPU architecture: ${arch}`);
  }

  const apps = await getCloudJson<CloudApplication>(
    `/v6/application?$select=id,slug,app_name&$filter=slug%20eq%20'${supervisorAppSlug(arch)}'`,
  );

  return apps[0] ?? null;
};

/**
 * All successful releases of a supervisor application, newest first
 * (`$orderby=id desc`), top 1000.
 */
export const fetchSupervisorReleases = async (applicationId: number): Promise<CloudRelease[]> =>
  getCloudJson<CloudRelease>(
    `/v6/release?$select=id,raw_version,semver,composition,variant` +
      `&$filter=belongs_to__application%20eq%20${applicationId}%20and%20status%20eq%20'success'` +
      `&$orderby=id%20desc&$top=1000`,
  );

/**
 * Images of one cloud release in a single expanded query. Expanded navigations
 * resolve to arrays; `is_a_build_of__service` carries the service name.
 */
export const fetchReleaseImages = async (releaseId: number): Promise<CloudReleaseImage[]> => {
  const rows = await getCloudJson<{ image: ExpandedCloudImage | ExpandedCloudImage[] }>(
    `/v6/release_image?$select=image&$filter=release%20eq%20${releaseId}` +
      `&$expand=image($select=is_stored_at__image_location,content_hash;` +
      `$expand=is_a_build_of__service($select=service_name))`,
  );

  const images: CloudReleaseImage[] = [];
  for (const row of rows) {
    for (const image of asArray(row.image)) {
      const service = asArray(image.is_a_build_of__service)[0] ?? image.is_a_build_of__service ?? undefined;
      const serviceName =
        service && !Array.isArray(service) ? (service.service_name ?? '') : (service?.service_name ?? '');

      if (image.is_stored_at__image_location && image.content_hash) {
        images.push({
          location: image.is_stored_at__image_location,
          contentHash: image.content_hash,
          serviceName,
        });
      }
    }
  }

  return images;
};

/** The verbatim balenaCloud release composition (copied into seeded releases). */
export const fetchCloudReleaseComposition = async (releaseId: number): Promise<unknown> => {
  const rows = await getCloudJson<{ composition?: unknown }>(`/v6/release(${releaseId})?$select=composition`);
  return rows[0]?.composition ?? {};
};

/**
 * Dedupe releases by semver, keeping the newest raw_version per semver
 * (releases arrive newest-first, so the first occurrence wins), and order the
 * result semver-descending using balena-semver. Pure — unit tested.
 */
export const dedupeAndOrderReleases = (releases: CloudRelease[]): CatalogVersion[] => {
  const bySemver = new Map<string, CatalogVersion>();
  for (const release of releases) {
    if (!release.semver || !release.raw_version) {
      continue;
    }
    if (!bySemver.has(release.semver)) {
      bySemver.set(release.semver, {
        semver: release.semver,
        rawVersion: release.raw_version,
        cloudReleaseId: release.id,
        variant: release.variant ?? '',
      });
    }
  }

  return [...bySemver.values()].sort((a, b) => balenaSemver.rcompare(a.semver, b.semver));
};

/** balena-semver comparison helper usable from both server and client code. */
export const compareSupervisorVersions = (left: string, right: string): number => balenaSemver.compare(left, right);

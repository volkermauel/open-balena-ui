import * as semver from 'semver';
import { OsImageError } from './errors';

export const DEFAULT_BALENACLOUD_API_URL = 'https://api.balena-cloud.com';

/**
 * Base URL of the balenaCloud API used for the public OS catalog (version listing + image
 * downloads). Configurable through `BALENACLOUD_API_URL` for air-gapped mirrors.
 */
export const balenaCloudApiUrl = (): string => {
  const url = process.env.BALENACLOUD_API_URL || DEFAULT_BALENACLOUD_API_URL;
  return url.replace(/\/+$/, '');
};

interface ReleaseQueryEntry {
  raw_version?: unknown;
}

interface ReleaseQueryResponse {
  d?: ReleaseQueryEntry[];
}

export const releaseListFilter = (deviceType: string): string =>
  `(is_final eq true) and (is_invalidated eq false) and (status eq 'success') and ` +
  `(semver_major gt 0) and (belongs_to__application/any(bta:(bta/is_host eq true) and ` +
  `(bta/is_for__device_type/any(dt:dt/slug eq '${encodeURIComponent(deviceType)}'))))`;

export const releaseListOrderBy = 'semver_major desc,semver_minor desc,semver_patch desc,revision desc';

/**
 * balenaCloud's request router rejects percent-encoded OData operators (`$select`, parentheses, …),
 * so the query is assembled with raw OData syntax and only spaces (`+`) and the device type slug
 * percent-encoded where required.
 */
export const osVersionsUrl = (deviceType: string): string =>
  `${balenaCloudApiUrl()}/v7/release?$select=raw_version` +
  `&$filter=${releaseListFilter(deviceType).replace(/ /g, '+')}` +
  `&$orderby=${releaseListOrderBy.replace(/ /g, '+')}`;

const compareOsVersionDesc = (a: string, b: string): number => {
  const parsedA = semver.parse(a, { loose: true });
  const parsedB = semver.parse(b, { loose: true });

  if (parsedA && parsedB) {
    return semver.rcompare(parsedA, parsedB);
  }
  if (parsedA) {
    return -1;
  }
  if (parsedB) {
    return 1;
  }
  return a.localeCompare(b);
};

/**
 * Extract the deduplicated list of raw_version values from a balenaCloud release query
 * payload, ordered semver-descending.
 */
export const extractOsVersions = (payload: unknown): string[] => {
  const entries = Array.isArray(payload)
    ? (payload as ReleaseQueryEntry[])
    : (payload as ReleaseQueryResponse | null | undefined)?.d;

  if (!Array.isArray(entries)) {
    return [];
  }

  const versions = new Set<string>();
  for (const entry of entries) {
    if (entry && typeof entry.raw_version === 'string' && entry.raw_version.length > 0) {
      versions.add(entry.raw_version);
    }
  }

  return Array.from(versions).sort(compareOsVersionDesc);
};

/**
 * Query balenaCloud's public release catalog for final, successful host OS releases of the
 * given device type slug and return the deduplicated raw_version values, newest first.
 */
export const listOsVersions = async (deviceType: string): Promise<string[]> => {
  const url = osVersionsUrl(deviceType);

  let payload: unknown;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new OsImageError(
        502,
        `balenaCloud version listing for device type '${deviceType}' failed with status ${response.status}: ${detail.slice(0, 300)}`,
      );
    }
    payload = await response.json();
  } catch (error) {
    if (error instanceof OsImageError) {
      throw error;
    }
    throw new OsImageError(
      502,
      `Failed to reach balenaCloud for device type '${deviceType}': ${
        error instanceof Error ? error.message : 'unknown network error'
      }`,
    );
  }

  return extractOsVersions(payload);
};

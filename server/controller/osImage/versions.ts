import * as balenaSemver from 'balena-semver';
import { OsImageError } from './errors';

export const DEFAULT_OS_IMAGE_SOURCE_REPO = 'volkermauel/balena-raspberrypi-abrp';

/** GitHub REST API base used for the mirror's release catalog and asset downloads. */
export const GITHUB_API_BASE_URL = 'https://api.github.com';

/** How long the in-process releases cache stays fresh (anonymous API budget: 60 req/h). */
export const MIRROR_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

/** Timeout for small mirror fetches (GitHub API catalog pages, SHA256SUMS text). */
export const MIRROR_FETCH_TIMEOUT_MS = 30 * 1000;

/**
 * The configured OS image mirror (`OS_IMAGE_SOURCE_REPO`): a GitHub `<owner>/<repo>`
 * that publishes `balenaos-<version>-<machine>.img.zip` release assets. Validated
 * at use so a misconfiguration surfaces as a typed error instead of a broken URL.
 */
export const osImageSourceRepo = (): string => {
  const repo = (process.env.OS_IMAGE_SOURCE_REPO || DEFAULT_OS_IMAGE_SOURCE_REPO).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new OsImageError(
      500,
      `OS_IMAGE_SOURCE_REPO must be of the form <owner>/<repo>, e.g. ${DEFAULT_OS_IMAGE_SOURCE_REPO} (got: ${repo})`,
    );
  }
  return repo;
};

/** GitHub releases listing URL for the mirror repo (anonymous, 100 per page). */
export const githubReleasesUrl = (repo: string): string => `${GITHUB_API_BASE_URL}/repos/${repo}/releases?per_page=100`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Asset-name pattern for a device type slug: `balenaos-<version>-<machine>.img.zip`
 * where `<machine>` equals the requested device type slug exactly (the slug is
 * embedded so hyphenated slugs like `raspberrypi4-64` cannot be mis-split).
 * Pure — unit tested.
 */
export const mirrorAssetRegex = (deviceType: string): RegExp =>
  new RegExp(`^balenaos-(?<version>.+)-${escapeRegExp(deviceType)}\\.img\\.zip$`);

/** Extract the balenaOS version from a mirror asset name for the device type. */
export const versionFromAssetName = (deviceType: string, assetName: string): string | null => {
  const match = mirrorAssetRegex(deviceType).exec(assetName);
  return match?.groups?.version ?? null;
};

export interface MirrorReleaseAsset {
  /** Asset file name, e.g. `balenaos-7.4.0+rev5-raspberrypi4-64.img.zip` or `SHA256SUMS`. */
  name: string;
  /** Direct (anonymous) download URL. */
  url: string;
}

export interface MirrorRelease {
  tagName: string;
  assets: MirrorReleaseAsset[];
}

interface RawGithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface RawGithubRelease {
  tag_name?: unknown;
  assets?: unknown;
}

/** Normalize a GitHub releases API payload into the catalog shape. Pure — unit tested. */
export const toMirrorReleases = (payload: unknown): MirrorRelease[] => {
  if (!Array.isArray(payload)) {
    return [];
  }
  const releases: MirrorRelease[] = [];
  for (const raw of payload as RawGithubRelease[]) {
    if (!raw || typeof raw.tag_name !== 'string') {
      continue;
    }
    const assets: MirrorReleaseAsset[] = [];
    if (Array.isArray(raw.assets)) {
      for (const asset of raw.assets as RawGithubAsset[]) {
        if (asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string') {
          assets.push({ name: asset.name, url: asset.browser_download_url });
        }
      }
    }
    releases.push({ tagName: raw.tag_name, assets });
  }
  return releases;
};

/**
 * `rel="next"` target of a Link header, e.g.
 * `<https://api.github.com/.../releases?per_page=100&page=2>; rel="next", <...>; rel="last"`.
 * Returns null when there is no next page. Pure — unit tested.
 */
export const nextReleasesUrlFromLink = (link: string | null): string | null => {
  if (!link) {
    return null;
  }
  for (const part of link.split(',')) {
    const entry = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    // `rel` may be quoted or bare (`rel="next"` / `rel=next`) and further params
    // (e.g. `title="page 2"`) may follow it within the same comma-separated entry.
    if (entry && /(^|;)\s*rel="?next"?\s*(;|$)/i.test(entry[2])) {
      return entry[1];
    }
  }
  return null;
};

// balena-semver's rcompare degrades gracefully for odd versions (it falls back to
// a plain compare internally), so no separate string fallback is wired in here.
const compareOsVersionDesc = (a: string, b: string): number => balenaSemver.rcompare(a, b);

/**
 * Extract the deduplicated balenaOS versions a mirror release listing serves for
 * the device type, ordered balena-semver descending. Pure — unit tested.
 */
export const extractOsVersions = (releases: MirrorRelease[], deviceType: string): string[] => {
  const versions = new Set<string>();
  for (const release of releases) {
    for (const asset of release.assets) {
      const version = versionFromAssetName(deviceType, asset.name);
      if (version !== null && version.length > 0) {
        versions.add(version);
      }
    }
  }
  return Array.from(versions).sort(compareOsVersionDesc);
};

interface MirrorCatalogCacheEntry {
  releases: MirrorRelease[];
  fetchedAt: number;
}
/** A resolved catalog entry, or the in-flight pagination run a cold miss started. */
type MirrorCatalogCache = MirrorCatalogCacheEntry | Promise<MirrorRelease[]>;

let mirrorCatalogCache: MirrorCatalogCache | null = null;

/** Drop the in-process releases cache (tests / forced re-read). */
export const clearMirrorCatalogCache = (): void => {
  mirrorCatalogCache = null;
};

/** Current cache entry for inspection; tests backdate `fetchedAt` to exercise the TTL. */
export const peekMirrorCatalogCache = (): MirrorCatalogCacheEntry | null =>
  mirrorCatalogCache !== null && 'releases' in mirrorCatalogCache ? mirrorCatalogCache : null;

/** Parse a `SHA256SUMS` payload (`<sha256>  <filename>` lines) into a map. Pure — unit tested. */
export const parseSha256Sums = (content: string): Map<string, string> => {
  const sums = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) {
      sums.set(match[2].trim(), match[1]);
    }
  }
  return sums;
};

/** One pagination run over the GitHub releases API; every failure maps to a typed 502. */
const paginateMirrorReleases = async (repo: string): Promise<MirrorRelease[]> => {
  const releases: MirrorRelease[] = [];
  let url: string | null = githubReleasesUrl(repo);
  let pages = 0;

  try {
    while (url) {
      pages += 1;
      if (pages > 50) {
        throw new OsImageError(502, `api.github.com release listing for ${repo} did not terminate after 50 pages`);
      }

      const response = await fetch(url, { signal: AbortSignal.timeout(MIRROR_FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new OsImageError(
          502,
          `api.github.com release listing for ${repo} failed with status ${response.status}: ${detail.slice(0, 300)}`,
        );
      }

      releases.push(...toMirrorReleases(await response.json()));
      url = nextReleasesUrlFromLink(response.headers.get('link'));
    }
  } catch (error) {
    if (error instanceof OsImageError) {
      throw error;
    }
    throw new OsImageError(
      502,
      `Failed to reach api.github.com for the release listing of ${repo}: ${
        error instanceof Error ? error.message : 'unknown network error'
      }`,
    );
  }
  return releases;
};

/**
 * Fetch the mirror's releases via the GitHub API (anonymous), following Link-header
 * pagination. Results are cached in-process for `MIRROR_CATALOG_CACHE_TTL_MS` so
 * version listings and prepare jobs share the anonymous-API budget; concurrent cold
 * misses share a single in-flight pagination run, and a rejected run evicts itself
 * so the cache is never poisoned.
 */
export const fetchMirrorReleases = (): Promise<MirrorRelease[]> => {
  const repo = osImageSourceRepo();

  if (mirrorCatalogCache) {
    if ('releases' in mirrorCatalogCache) {
      if (Date.now() - mirrorCatalogCache.fetchedAt < MIRROR_CATALOG_CACHE_TTL_MS) {
        return Promise.resolve(mirrorCatalogCache.releases);
      }
    } else {
      // A cold miss is already paginating: share that run instead of racing a second
      // one against the same anonymous-API budget.
      return mirrorCatalogCache;
    }
  }

  const inFlight = paginateMirrorReleases(repo).then(
    (releases) => {
      mirrorCatalogCache = { releases, fetchedAt: Date.now() };
      return releases;
    },
    (error: unknown) => {
      if (mirrorCatalogCache === inFlight) {
        mirrorCatalogCache = null;
      }
      throw error;
    },
  );
  mirrorCatalogCache = inFlight;
  return inFlight;
};

/**
 * List the balenaOS versions the mirror serves for a device type slug: releases
 * carrying a `balenaos-<version>-<slug>.img.zip` asset, deduplicated and newest
 * first. balenaCloud is not consulted.
 */
export const listOsVersions = async (deviceType: string): Promise<string[]> =>
  extractOsVersions(await fetchMirrorReleases(), deviceType);

export interface MirrorAsset {
  /** Asset file name, e.g. `balenaos-7.4.0+rev5-raspberrypi4-64.img.zip`. */
  name: string;
  /** Direct (anonymous) download URL of the asset. */
  url: string;
  /** sha256 from the release's SHA256SUMS entry; undefined when release/entry is missing. */
  sha256: string | undefined;
}

const SHA256SUMS_ASSET_NAME = 'SHA256SUMS';

/**
 * Resolve the mirror's download asset for a (deviceType, version): the
 * `balenaos-<version>-<deviceType>.img.zip` release asset plus the sha256 from
 * the same release's `SHA256SUMS` (undefined when the release has no sums file
 * or no entry for the asset — callers must fail closed then).
 */
export const findMirrorAsset = async (deviceType: string, version: string): Promise<MirrorAsset> => {
  const repo = osImageSourceRepo();
  const assetName = `balenaos-${version}-${deviceType}.img.zip`;

  const release = (await fetchMirrorReleases()).find((entry) => entry.assets.some((asset) => asset.name === assetName));
  const asset = release?.assets.find((candidate) => candidate.name === assetName);
  if (!release || !asset) {
    throw new OsImageError(
      404,
      `No balenaOS image found for device type '${deviceType}' version '${version}' on the mirror ${repo}`,
    );
  }

  const sumsAsset = release.assets.find((candidate) => candidate.name === SHA256SUMS_ASSET_NAME);
  if (!sumsAsset) {
    return { name: assetName, url: asset.url, sha256: undefined };
  }

  let sumsBody: string;
  try {
    const response = await fetch(sumsAsset.url, { signal: AbortSignal.timeout(MIRROR_FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      throw new OsImageError(502, `Fetching SHA256SUMS from the mirror ${repo} failed with status ${response.status}`);
    }
    sumsBody = await response.text();
  } catch (error) {
    if (error instanceof OsImageError) {
      throw error;
    }
    throw new OsImageError(
      502,
      `Failed to reach the mirror ${repo} for SHA256SUMS: ${
        error instanceof Error ? error.message : 'unknown network error'
      }`,
    );
  }

  return { name: assetName, url: asset.url, sha256: parseSha256Sums(sumsBody).get(assetName) };
};

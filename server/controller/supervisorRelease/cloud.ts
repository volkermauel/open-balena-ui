import * as balenaSemver from 'balena-semver';
import { errorMessage, UpstreamError } from './errors';
import { getSourceToken, SourceRegistryConfig, supervisorSourceRegistry, supervisorSourceRepo } from './registryMirror';
import { isSemverVersion } from './semver';

/**
 * Supervisor version catalog: mirror tags from the configured ghcr-style
 * source registry (`SUPERVISOR_SOURCE_REGISTRY`), pulled anonymously, with
 * balenaCloud's public supervisor catalog as best-effort metadata enrichment.
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

/** The release's single image as far as catalog consumers need it. */
export interface CloudReleaseImage {
  serviceName: string;
}

/** A listed version after mirror-tag ordering and cloud enrichment. */
export interface CatalogVersion {
  semver: string;
  rawVersion: string;
  /** Raw mirror tag this entry was listed from ('' for cloud-only entries). */
  mirrorTag: string;
  cloudReleaseId: number;
  variant: string;
  /** Service name of the release's single image ('supervisor' when unknown). */
  serviceName: string;
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
        images.push({ serviceName });
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
        mirrorTag: '',
        cloudReleaseId: release.id,
        variant: release.variant ?? '',
        serviceName: 'supervisor',
      });
    }
  }

  return [...bySemver.values()].sort((a, b) => balenaSemver.rcompare(a.semver, b.semver));
};

/**
 * Tag shape accepted as a supervisor version: an optional `v` prefix on a
 * semver body (design.md). The anchored shape alone is not enough — it
 * admits e.g. `19.0.8.1` — so every candidate is additionally checked with
 * the exact parser `parseSemverFields` uses at seed time: a tag is listed
 * only if seeding could parse its semver.
 */
const SUPERVISOR_TAG_PATTERN = /^v?\d+\.\d+\.\d+([-.+].*)?$/;

/**
 * Turn the mirror's raw tag list into catalog versions: keep tags whose
 * semver the seed-time parser accepts, strip a leading `v` for the semver
 * value (the raw tag is kept on the entry), dedupe by semver preferring the
 * `v`-prefixed raw tag, and order the result semver-descending using
 * balena-semver. Pure — unit tested.
 */
export const mirrorTagsToVersions = (tags: string[]): CatalogVersion[] => {
  const bySemver = new Map<string, CatalogVersion>();
  for (const tag of tags) {
    const semver = tag.replace(/^v/, '');
    if (!SUPERVISOR_TAG_PATTERN.test(tag) || !isSemverVersion(semver)) {
      continue;
    }
    const existing = bySemver.get(semver);
    // Prefer the `v`-prefixed raw tag when both spellings exist.
    if (!existing || (!existing.mirrorTag.startsWith('v') && tag.startsWith('v'))) {
      bySemver.set(semver, {
        semver,
        rawVersion: tag,
        mirrorTag: tag,
        cloudReleaseId: 0,
        variant: '',
        serviceName: 'supervisor',
      });
    }
  }

  return [...bySemver.values()].sort((a, b) => balenaSemver.rcompare(a.semver, b.semver));
};

/**
 * Fetch the mirror repository's tags (anonymous pull token, `tags/list`).
 * A missing or private/nonexistent repository is an empty arch, not an
 * error: ghcr issues anonymous tokens regardless and answers `tags/list`
 * with 404, and registries that refuse the anonymous token or the tag list
 * itself (401/403) get the same treatment. A real outage answers 5xx or
 * fails at the network level, which still raises an upstream error.
 */
const fetchMirrorTags = async (source: SourceRegistryConfig, repo: string): Promise<string[]> => {
  let token: string;
  try {
    token = await getSourceToken(source, repo);
  } catch (error) {
    if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) {
      return [];
    }
    throw error;
  }

  let res: Response;
  try {
    res = await fetch(`${source.url}/v2/${repo}/tags/list?n=1000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new UpstreamError(
      `Supervisor source tags request failed: cannot reach ${source.url}/${repo} (${errorMessage(error)})`,
    );
  }
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    return []; // missing, private or unreadable repository — a legitimately empty arch
  }
  if (!res.ok) {
    throw new UpstreamError(
      `Supervisor source tags request failed (${res.status}) for ${source.url}/${repo}`,
      res.status,
    );
  }
  // ghcr signals further pages via a Link header; anything beyond the first
  // page would be silently truncated, so surface it instead of hiding it.
  const link = res.headers.get('link');
  if (link?.includes('rel="next"')) {
    console.warn(`Supervisor source tag list for ${repo} is paginated; showing the first 1000 tags only`);
  }

  const body = (await res.json().catch(() => null)) as { tags?: unknown } | null;
  if (!body || !Array.isArray(body.tags)) {
    throw new UpstreamError(`Supervisor source returned no tag list for ${repo}`);
  }
  return body.tags.filter((tag): tag is string => typeof tag === 'string');
};

/**
 * Supervisor versions for a CPU arch: the mirror repository's tags, ordered
 * newest-first and enriched with balenaCloud public-catalog metadata (variant,
 * cloud release id) on a best-effort basis — enrichment failure never fails
 * the listing; versions unknown to balenaCloud list with defaults.
 */
export const listMirrorVersions = async (arch: string): Promise<CatalogVersion[]> => {
  const source = supervisorSourceRegistry();
  const repo = supervisorSourceRepo(arch);
  const versions = mirrorTagsToVersions(await fetchMirrorTags(source, repo));
  if (versions.length === 0) {
    return []; // empty arch — not worth a pair of enrichment round-trips
  }

  let cloudBySemver = new Map<string, CatalogVersion>();
  try {
    const application = await fetchSupervisorApplication(arch);
    if (application) {
      cloudBySemver = new Map(
        dedupeAndOrderReleases(await fetchSupervisorReleases(application.id)).map((entry) => [entry.semver, entry]),
      );
    }
  } catch {
    // Enrichment is best-effort: list the mirror tags with default metadata.
  }

  return versions.map((version) => {
    const cloud = cloudBySemver.get(version.semver);
    return cloud ? { ...version, variant: cloud.variant, cloudReleaseId: cloud.cloudReleaseId } : version;
  });
};

/**
 * Service name of a catalog version's single image from the balenaCloud
 * catalog; 'supervisor' when the version is unknown there or the catalog is
 * unreachable. Best-effort — never throws.
 */
export const serviceNameForVersion = async (catalog: CatalogVersion): Promise<string> => {
  if (!catalog.cloudReleaseId) {
    return 'supervisor';
  }
  try {
    const images = await fetchReleaseImages(catalog.cloudReleaseId);
    return images[0]?.serviceName || 'supervisor';
  } catch {
    return 'supervisor';
  }
};

/** balena-semver comparison helper usable from both server and client code. */
export const compareSupervisorVersions = (left: string, right: string): number => balenaSemver.compare(left, right);

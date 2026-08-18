import * as balenaSemver from 'balena-semver';
import { HostosNotConfiguredError, UpstreamError } from './errors';
import {
  getSourceToken,
  isRegistryDigest,
  MANIFEST_ACCEPT_HEADER,
  SourceRegistryConfig,
} from '../supervisorRelease/registryMirror';

/**
 * Catalog client for the hostOS ghcr mirror (`HOSTOS_SOURCE_REGISTRY`, default
 * `ghcr.io/volkermauel/balenaos-hostapp`): anonymous `tags/list` per machine
 * plus a manifest HEAD by tag to resolve a version's digest. Tag convention
 * (verified): the ghcr tag is the balenaOS version with `+` swapped to `-`
 * (`v7.4.0+rev5` ↔ `7.4.0-rev5`, `v19.0.8` ↔ `v19.0.8`); machines map 1:1 to
 * device-type slugs.
 */

export const DEFAULT_HOSTOS_SOURCE_REGISTRY = 'ghcr.io/volkermauel/balenaos-hostapp';
export const DEFAULT_HOSTOS_SOURCE_REPO = 'volkermauel/balena-raspberrypi-abrp';

/** Companion GitHub repo of the mirror (`HOSTOS_SOURCE_REPO`) — informational: catalog cross-check / release links. */
export const hostosSourceRepo = (): string => process.env.HOSTOS_SOURCE_REPO || DEFAULT_HOSTOS_SOURCE_REPO;

export interface HostosSource {
  /** Registry host, e.g. `ghcr.io`. */
  host: string;
  /** Registry base URL without a trailing slash, e.g. `https://ghcr.io`. */
  url: string;
  /** Repository path prefix below the host, e.g. `volkermauel/balenaos-hostapp` (may be empty). */
  pathPrefix: string;
}

/**
 * Parse a `HOSTOS_SOURCE_REGISTRY` value into host + repository path. Accepted
 * forms (pure — unit tested): `host/owner/path`, `host:port/owner/path` and
 * the same with an `https?://` scheme prefix; a trailing slash is ignored.
 * The first segment must be a host (contain `.` or `:port`) so `owner/repo`
 * alone is rejected rather than silently misread.
 */
export const parseHostosSourceRegistry = (value: string): HostosSource => {
  const normalized = value.trim().replace(/\/+$/, '');
  const scheme = /^http:\/\//i.test(normalized) ? 'http' : 'https';
  const withoutScheme = normalized.replace(/^https?:\/\//i, '');
  const segments = withoutScheme.split('/').filter((segment) => segment.length > 0);
  const host = segments[0] ?? '';

  if (segments.length === 0 || !/^[a-zA-Z0-9.-]+(:\d+)?$/.test(host) || !/[.:]/.test(host)) {
    throw new HostosNotConfiguredError(
      `HOSTOS_SOURCE_REGISTRY must be of the form <registry-host>[/owner/path], e.g. ${DEFAULT_HOSTOS_SOURCE_REGISTRY}: ${value}`,
    );
  }

  return { host, url: `${scheme}://${host}`, pathPrefix: segments.slice(1).join('/') };
};

/** The configured hostOS source mirror (anonymous pulls, no credential). */
export const hostosSource = (): HostosSource =>
  parseHostosSourceRegistry(process.env.HOSTOS_SOURCE_REGISTRY || DEFAULT_HOSTOS_SOURCE_REGISTRY);

/** The ghcr source as a mirror source config: anonymous pull tokens, never a credential. */
export const hostosSourceRegistryConfig = (source: HostosSource): SourceRegistryConfig => ({
  url: source.url,
  auth: 'anonymous',
});

/** The ghcr machine name for a device type slug — 1:1 today (`raspberrypi4-64`, `raspberrypi5`). */
export const machineForDeviceType = (deviceTypeSlug: string): string => deviceTypeSlug;

/** Slug of the device type's hostapp application on the instance. */
export const hostappApplicationSlug = (deviceTypeSlug: string): string => `admin/${deviceTypeSlug}`;

/**
 * Repository path a machine is mirrored INTO the instance registry at
 * (design decision: fixed per machine, independent of the source owner) —
 * the image row's location is `<registryHost>/v2/${repo}` and pulls are
 * digest-pinned via the image `content_hash`.
 */
export const hostosTargetRepo = (machine: string): string => `balenaos-hostapp/${machine}`;

/** Repository path of a machine at the source mirror: `<pathPrefix>/<machine>`. */
export const sourceRepo = (source: HostosSource, machine: string): string =>
  source.pathPrefix ? `${source.pathPrefix}/${machine}` : machine;

/** Docker tag shape accepted in registry URL paths (every tag used in a URL is checked). */
export const isRegistryTag = (tag: string): boolean => /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/.test(tag);

export interface HostosVersion {
  /** ghcr tag verbatim, e.g. `7.4.0-rev5` or `v19.0.8`. */
  tag: string;
  /** balenaOS version (semver form), e.g. `7.4.0+rev5` or `19.0.8`; the tag itself when unparsable. */
  version: string;
  /** False when the tag is not a `x.y.z[-suffix]` version; such entries sort last and cannot be imported. */
  parsable: boolean;
}

/**
 * Parse one ghcr tag into its balenaOS version by reversing the publish
 * convention: strip an optional leading `v`, then turn the first `-` after the
 * `x.y.z` core back into the `+` it was published from (`7.4.0-rev5` →
 * `7.4.0+rev5`). Returns null for anything that does not start with a plain
 * `x.y.z` core. Pure — unit tested.
 */
export const parseHostosTag = (tag: string): { tag: string; version: string } | null => {
  const match = /^v?(\d+\.\d+\.\d+)(?:-(.+))?$/.exec(tag.trim());
  if (!match) {
    return null;
  }
  return { tag, version: match[2] === undefined ? match[1] : `${match[1]}+${match[2]}` };
};

/**
 * Turn the mirror's raw tag list into the version listing: parsed tags ordered
 * newest-first by balena-semver and deduplicated per version (first entry
 * wins), then unparsable tags at the end in raw descending string order.
 * Pure — unit tested.
 */
export const orderHostosTags = (tags: string[]): HostosVersion[] => {
  const parsable: HostosVersion[] = [];
  const unparsable: HostosVersion[] = [];

  for (const tag of tags) {
    const parsed = parseHostosTag(tag);
    if (parsed) {
      parsable.push({ tag: parsed.tag, version: parsed.version, parsable: true });
    } else {
      unparsable.push({ tag, version: tag, parsable: false });
    }
  }

  parsable.sort((a, b) => balenaSemver.rcompare(a.version, b.version));
  unparsable.sort((a, b) => (a.tag > b.tag ? -1 : a.tag < b.tag ? 1 : 0));

  const byVersion = new Map<string, HostosVersion>();
  for (const entry of [...parsable, ...unparsable]) {
    if (!byVersion.has(entry.version)) {
      byVersion.set(entry.version, entry);
    }
  }
  return [...byVersion.values()];
};

/** Fetch the mirror's tags for a machine (anonymous pull token, `tags/list`). */
export const fetchHostosTags = async (machine: string): Promise<string[]> => {
  const source = hostosSource();
  const repo = sourceRepo(source, machine);
  const token = await getSourceToken(hostosSourceRegistryConfig(source), repo);

  const res = await fetch(`${source.url}/v2/${repo}/tags/list?n=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new UpstreamError(`HostOS source tags request failed (${res.status}) for ${repo}`);
  }

  const body = (await res.json().catch(() => null)) as { tags?: unknown } | null;
  if (!body || !Array.isArray(body.tags)) {
    throw new UpstreamError(`HostOS source returned no tag list for ${repo}`);
  }
  return body.tags.filter((tag): tag is string => typeof tag === 'string');
};

/**
 * Resolve a tag's manifest digest at the mirror via a manifest HEAD: the
 * registry's `docker-content-digest` is the digest the bytes are mirrored (and
 * content-hashed) by.
 */
export const fetchHostosTagDigest = async (machine: string, tag: string): Promise<string> => {
  if (!isRegistryTag(tag)) {
    throw new UpstreamError(`Invalid hostOS source tag: ${tag}`);
  }

  const source = hostosSource();
  const repo = sourceRepo(source, machine);
  const token = await getSourceToken(hostosSourceRegistryConfig(source), repo);

  const res = await fetch(`${source.url}/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
    method: 'HEAD',
    headers: { Accept: MANIFEST_ACCEPT_HEADER, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new UpstreamError(`HostOS source manifest check failed (${res.status}) for ${machine}:${tag}`);
  }

  const digest = res.headers.get('docker-content-digest');
  if (!digest || !isRegistryDigest(digest)) {
    throw new UpstreamError(`HostOS source reported no valid digest for ${machine}:${tag}`);
  }
  return digest;
};

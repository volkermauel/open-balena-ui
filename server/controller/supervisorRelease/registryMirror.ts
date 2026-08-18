import { createHash } from 'node:crypto';
import { errorMessage, RegistryMirrorError, SupervisorTagMissingError, UpstreamError } from './errors';

/**
 * Byte-identical image mirroring from a source registry into the instance's
 * own registry.
 *
 * - The source is a parameter: an anonymous public registry such as the ghcr
 *   supervisor/hostOS mirrors (pull tokens without any credential).
 * - Manifests are copied as raw bytes, PUT by digest with the source
 *   Content-Type, so the digest (and therefore the `content_hash`) stays
 *   valid at the target.
 * - Manifest lists / OCI indices recurse into their child manifests first.
 * - Blobs (config + layers) are HEAD-checked at the target and only copied
 *   when missing, streaming source→target (never buffered in memory).
 * - Pulls are authorized with a source pull token; pushes use the caller's
 *   instance JWT through the instance's `/auth/v1/token`.
 */

/** How pulls against a source registry are authorized (anonymous public mirrors only). */
export type SourceAuthMode = 'anonymous';

export interface SourceRegistryConfig {
  /** Registry API base URL without a trailing slash, e.g. `https://ghcr.io`. */
  url: string;
  auth: SourceAuthMode;
}

export const DEFAULT_SUPERVISOR_SOURCE_REGISTRY = 'ghcr.io/volkermauel';

export interface SupervisorSource {
  /** Registry host, e.g. `ghcr.io`. */
  host: string;
  /** Registry API base URL without a trailing slash, e.g. `https://ghcr.io`. */
  url: string;
  /** Owner path segment below the host ('' when the registry hosts repositories at its root). */
  owner: string;
}

/**
 * Parse a `SUPERVISOR_SOURCE_REGISTRY` value of the form `<registry-host>[/owner]`.
 * Pure — unit tested. Mirrors the `HOSTOS_SOURCE_REGISTRY` contract: an
 * `https?://` scheme prefix (`http://` is preserved, anything else becomes
 * `https`) and trailing slashes are ignored. The host must be lowercase and
 * contain a dot (a `:port` suffix is allowed); at most one lowercase owner
 * segment may follow. Anything else is a configuration error.
 */
export const parseSupervisorSourceRegistry = (value: string): SupervisorSource => {
  const normalized = value.trim().replace(/\/+$/, '');
  const scheme = /^http:\/\//i.test(normalized) ? 'http' : 'https';
  const withoutScheme = normalized.replace(/^https?:\/\//i, '');
  const segments = withoutScheme.split('/');
  const host = segments[0] ?? '';
  const owner = segments.length > 1 ? segments[1] : '';

  const hostValid = /^[a-z0-9.-]+(:\d+)?$/.test(host) && host.includes('.');
  const ownerValid = segments.length <= 2 && (segments.length === 1 || /^[a-z0-9][a-z0-9_-]*$/.test(owner));
  const noEmptySegments = segments.every((segment) => segment.length > 0);

  if (!hostValid || !ownerValid || !noEmptySegments) {
    throw new RegistryMirrorError(
      `SUPERVISOR_SOURCE_REGISTRY must be of the form <registry-host>[/owner], ` +
        `e.g. ${DEFAULT_SUPERVISOR_SOURCE_REGISTRY}: ${value}`,
    );
  }

  return { host, url: `${scheme}://${host}`, owner };
};

const supervisorSource = (): SupervisorSource =>
  parseSupervisorSourceRegistry(process.env.SUPERVISOR_SOURCE_REGISTRY || DEFAULT_SUPERVISOR_SOURCE_REGISTRY);

/** The configured supervisor source mirror: anonymous pull tokens, never a credential. */
export const supervisorSourceRegistry = (): SourceRegistryConfig => ({
  url: supervisorSource().url,
  auth: 'anonymous',
});

/** Repository-path shape accepted for source and target repositories. */
const REPO_PATH_PATTERN = /^[a-z0-9][a-z0-9/_-]*$/;

/** Source repository of a supervisor arch on the mirror: `<owner>/<arch>-supervisor` (no owner → `<arch>-supervisor`). */
export const supervisorSourceRepo = (arch: string): string => {
  const { owner } = supervisorSource();
  const repo = owner ? `${owner}/${arch}-supervisor` : `${arch}-supervisor`;
  if (!REPO_PATH_PATTERN.test(repo)) {
    throw new RegistryMirrorError(
      `Invalid supervisor source repository for arch ${arch}: ${repo} (check SUPERVISOR_SOURCE_REGISTRY)`,
    );
  }
  return repo;
};

/**
 * Repository path a supervisor arch is mirrored INTO the instance registry at
 * (fixed per arch, independent of the source owner — same decision as the
 * hostOS mirror); the image row's location is `<registryHost>/v2/${repo}` and
 * pulls are digest-pinned via the image `content_hash`.
 */
export const supervisorTargetRepo = (arch: string): string => {
  const repo = `${arch}-supervisor`;
  if (!REPO_PATH_PATTERN.test(repo)) {
    throw new RegistryMirrorError(`Invalid supervisor target repository for arch ${arch}: ${repo}`);
  }
  return repo;
};

export const MANIFEST_ACCEPT_HEADER =
  'application/vnd.docker.distribution.manifest.v2+json, ' +
  'application/vnd.docker.distribution.manifest.list.v2+json, ' +
  'application/vnd.oci.image.manifest.v1+json, ' +
  'application/vnd.oci.image.index.v1+json';

const LIST_MEDIA_TYPES = new Set([
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
]);

/** Derive the instance registry host from the instance API URL host: leftmost label → `registry2`. Pure — unit tested. */
export const deriveRegistryHost = (apiUrl: string): string => {
  let host: string;
  try {
    host = new URL(apiUrl).host;
  } catch {
    throw new RegistryMirrorError(`Cannot derive registry host from invalid API URL: ${apiUrl}`);
  }

  const labels = host.split('.');
  if (labels.length < 2) {
    throw new RegistryMirrorError(`Cannot derive registry host from API host: ${host}`);
  }

  labels[0] = 'registry2';
  return labels.join('.');
};

/** Base URL of the instance registry (no trailing slash). */
export const targetRegistryUrl = (): string => {
  const configured = process.env.OPEN_BALENA_REGISTRY_URL;
  if (configured) {
    return (/^https?:\/\//.test(configured) ? configured : `https://${configured}`).replace(/\/+$/, '');
  }
  const apiUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  if (!apiUrl) {
    throw new RegistryMirrorError('Neither OPEN_BALENA_REGISTRY_URL nor REACT_APP_OPEN_BALENA_API_URL is configured');
  }
  return `https://${deriveRegistryHost(apiUrl)}`;
};

/** Host the instance registry token service expects as `service` parameter. */
export const targetRegistryHost = (): string => new URL(targetRegistryUrl()).host;

// ---------------------------------------------------------------------------
// Structure inspection (pure, unit tested)
// ---------------------------------------------------------------------------

export interface ManifestInspection {
  isList: boolean;
  /** Digests of child manifests referenced by a manifest list / OCI index. */
  childManifestDigests: string[];
  /** Digests of referenced blobs (config + layers) for a single manifest. */
  blobDigests: string[];
}

/** Digest shape accepted in registry paths — every digest used in a URL is checked. */
export const isRegistryDigest = (digest: string): boolean => /^sha256:[a-f0-9]{64}$/.test(digest);

const assertDigest = (digest: string): string => {
  if (!isRegistryDigest(digest)) {
    throw new RegistryMirrorError(`Invalid registry digest: ${digest}`);
  }
  return digest;
};

/** Inspect a parsed manifest/index: list membership, child manifests, blobs. Pure — unit tested. */
export const inspectManifest = (manifest: unknown): ManifestInspection => {
  if (!manifest || typeof manifest !== 'object') {
    throw new RegistryMirrorError('Manifest is not a JSON object');
  }

  const record = manifest as Record<string, unknown>;
  const mediaType = typeof record.mediaType === 'string' ? record.mediaType : '';
  const hasManifests = Array.isArray(record.manifests);
  const isList = LIST_MEDIA_TYPES.has(mediaType) || (hasManifests && !Array.isArray(record.layers));

  if (isList) {
    const children = (record.manifests as unknown[]).map((entry, index) => {
      if (!entry || typeof entry !== 'object' || typeof (entry as { digest?: unknown }).digest !== 'string') {
        throw new RegistryMirrorError(`Manifest list entry ${index} has no digest`);
      }
      const digest = (entry as { digest: string }).digest;
      if (!isRegistryDigest(digest)) {
        throw new RegistryMirrorError(`Manifest list entry ${index} has an invalid digest: ${digest}`);
      }
      return digest;
    });
    return { isList: true, childManifestDigests: children, blobDigests: [] };
  }

  const blobs: string[] = [];
  const config = record.config;
  if (config && typeof config === 'object' && typeof (config as { digest?: unknown }).digest === 'string') {
    blobs.push(assertDigest((config as { digest: string }).digest));
  }
  const layers = record.layers;
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      if (layer && typeof layer === 'object' && typeof (layer as { digest?: unknown }).digest === 'string') {
        blobs.push(assertDigest((layer as { digest: string }).digest));
      }
    }
  }

  if (blobs.length === 0 && !Array.isArray(layers) && !config) {
    throw new RegistryMirrorError('Manifest references neither blobs nor child manifests');
  }

  return { isList: false, childManifestDigests: [], blobDigests: blobs };
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface TokenResponse {
  token?: string;
  access_token?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** JWT `exp` minus a safety skew; opaque tokens fall back to a short TTL. */
const tokenExpiryMs = (token: string): number => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf8')) as {
      exp?: unknown;
    };
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp) && payload.exp > 0) {
      return payload.exp * 1000 - 60_000;
    }
  } catch {
    // Opaque token — cannot read an expiry.
  }
  return Date.now() + 5 * 60_000;
};

const freshToken = (cache: Map<string, CachedToken>, key: string): string | undefined => {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  cache.delete(key);
  return undefined;
};

const sourceTokens = new Map<string, CachedToken>();

/**
 * Pull token for a source repository, cached per (auth mode, registry, repo)
 * with a TTL. Sources are anonymous public registries (ghcr packages): a
 * pull token is fetched without sending any credential.
 */
export const getSourceToken = async (source: SourceRegistryConfig, repo: string): Promise<string> => {
  const cacheKey = `${source.auth}|${source.url}|${repo}`;
  const cached = freshToken(sourceTokens, cacheKey);
  if (cached) {
    return cached;
  }

  // Anonymous pull token (verified against ghcr: GET <registry>/token?scope=repository:<repo>:pull,
  // no Authorization header).
  const url = `${source.url}/token?scope=${encodeURIComponent(`repository:${repo}:pull`)}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    throw new UpstreamError(
      `Source registry token request failed: cannot reach ${source.url} (${errorMessage(error)})`,
    );
  }
  if (!res.ok) {
    throw new UpstreamError(`Source registry token request failed (${res.status}) for ${source.url}`, res.status);
  }

  const body = (await res.json()) as TokenResponse;
  const token = body.token ?? body.access_token;
  if (!token) {
    throw new UpstreamError('Source registry token response contained no token');
  }

  sourceTokens.set(cacheKey, { token, expiresAt: tokenExpiryMs(token) });
  return token;
};

/**
 * Resolve a tag's manifest digest at a source registry: GET the manifest by
 * tag (Accept: manifest+index types, source pull token) and take the
 * registry's `docker-content-digest` response header (read case-insensitively);
 * a registry that omits it — or reports a malformed one — gets the sha256 of
 * the raw body. The result is always digest-validated — it becomes the image
 * row's `content_hash` and the value mirrored and verified. A missing tag
 * throws SupervisorTagMissingError; other failures are upstream errors.
 */
export const resolveTagDigest = async (repo: string, tag: string, source: SourceRegistryConfig): Promise<string> => {
  if (!REPO_PATH_PATTERN.test(repo)) {
    throw new RegistryMirrorError(`Invalid source repository: ${repo}`);
  }
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/.test(tag)) {
    throw new RegistryMirrorError(`Invalid source tag: ${tag}`);
  }

  const token = await getSourceToken(source, repo);
  let res: Response;
  try {
    res = await fetch(`${source.url}/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
      headers: { Accept: MANIFEST_ACCEPT_HEADER, Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new UpstreamError(
      `Source registry manifest request failed: cannot reach ${source.url}/${repo}:${tag} (${errorMessage(error)})`,
    );
  }
  if (res.status === 404) {
    throw new SupervisorTagMissingError(`tag ${tag}`, repo, source.url);
  }
  if (!res.ok) {
    throw new UpstreamError(
      `Source registry manifest request failed (${res.status}) for ${source.url}/${repo}:${tag}`,
      res.status,
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const reported = res.headers.get('docker-content-digest');
  // A present-but-malformed header falls back to the body hash instead of
  // failing the resolution; an absent header always did.
  const digest =
    reported !== null && isRegistryDigest(reported)
      ? reported
      : `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return assertDigest(digest);
};

const targetTokens = new Map<string, CachedToken>();

const getTargetToken = async (repo: string, callerAuthorization: string): Promise<string> => {
  // Keyed by caller so one user's registry token is never reused for another.
  const cacheKey = `${callerAuthorization}|${repo}`;
  const cached = freshToken(targetTokens, cacheKey);
  if (cached) {
    return cached;
  }

  const apiUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  if (!apiUrl) {
    throw new RegistryMirrorError('REACT_APP_OPEN_BALENA_API_URL is not configured on the server');
  }

  const url =
    `${apiUrl.replace(/\/+$/, '')}/auth/v1/token?service=${encodeURIComponent(targetRegistryHost())}` +
    `&scope=${encodeURIComponent(`repository:${repo}:pull,push`)}`;
  const res = await fetch(url, { headers: { Authorization: callerAuthorization } });
  if (!res.ok) {
    throw new RegistryMirrorError(`Instance registry token request failed (${res.status})`);
  }

  const body = (await res.json()) as TokenResponse;
  const token = body.token ?? body.access_token;
  if (!token) {
    throw new RegistryMirrorError('Instance registry token response contained no token');
  }

  targetTokens.set(cacheKey, { token, expiresAt: tokenExpiryMs(token) });
  return token;
};

/** Test hook: clear cached tokens. */
export const resetRegistryTokens = (): void => {
  sourceTokens.clear();
  targetTokens.clear();
};

// ---------------------------------------------------------------------------
// Per-repo in-process lock (concurrent seeds must not double-copy)
// ---------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<unknown>>();

/** Serialize work per repository within this process (FIFO on the tail promise). */
export const withRepoLock = async <T>(repo: string, work: () => Promise<T>): Promise<T> => {
  const tail = (repoLocks.get(repo) ?? Promise.resolve()) as Promise<unknown>;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  repoLocks.set(
    repo,
    tail.then(() => gate),
  );

  await tail;
  try {
    return await work();
  } finally {
    release();
  }
};

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const resolveLocation = (baseUrl: string, location: string | null): string => {
  if (!location) {
    throw new RegistryMirrorError('Registry returned no Location header');
  }
  if (/^https?:\/\//i.test(location)) {
    return location;
  }
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    throw new RegistryMirrorError(`Registry returned an unusable Location header: ${location}`);
  }
};

const registryFetch = async (url: string, init: RequestInit, what: string): Promise<Response> => {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { errors?: { message?: string }[] };
      detail = (body.errors ?? [])
        .map((error) => error.message ?? '')
        .join('; ')
        .slice(0, 200);
    } catch {
      // non-JSON error body
    }
    throw new RegistryMirrorError(`${what} failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return res;
};

// ---------------------------------------------------------------------------
// Copy operations
// ---------------------------------------------------------------------------

interface ManifestCopy {
  digest: string;
  mediaType: string;
  bytes: Buffer;
}

/** Copy one blob (config or layer) unless it already exists at the target. Streams, never buffers. */
const copyBlobIfMissing = async (
  sourceRepo: string,
  targetRepo: string,
  digest: string,
  sourceUrl: string,
  sourceToken: string,
  targetToken: string,
): Promise<void> => {
  assertDigest(digest);
  const targetBase = targetRegistryUrl();

  const head = await fetch(`${targetBase}/v2/${targetRepo}/blobs/${digest}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${targetToken}` },
  });
  if (head.ok) {
    return;
  }
  if (head.status !== 404) {
    throw new RegistryMirrorError(`Blob existence check for ${digest} failed (${head.status})`);
  }

  const source = await registryFetch(
    `${sourceUrl}/v2/${sourceRepo}/blobs/${digest}`,
    { headers: { Authorization: `Bearer ${sourceToken}` } },
    `Source blob fetch ${digest}`,
  );
  if (!source.body) {
    throw new RegistryMirrorError(`Source blob ${digest} has no body`);
  }

  // Start the upload session; the Location may be absolute or relative and may
  // point at a different host/scheme than the registry API base.
  const postUrl = `${targetBase}/v2/${targetRepo}/blobs/uploads/`;
  const post = await fetch(postUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${targetToken}` },
  });
  if (post.status !== 202) {
    throw new RegistryMirrorError(`Blob upload initiation for ${digest} failed (${post.status})`);
  }
  const location = resolveLocation(postUrl, post.headers.get('location'));
  const putUrl = location + (location.includes('?') ? '&' : '?') + `digest=${encodeURIComponent(digest)}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${targetToken}`,
    'Content-Type': source.headers.get('content-type') ?? 'application/octet-stream',
  };
  const contentLength = source.headers.get('content-length');
  if (contentLength) {
    headers['Content-Length'] = contentLength;
  }

  // `duplex: 'half'` streams the body through without buffering; it is absent
  // from older RequestInit typings, hence the widened type.
  const putInit: RequestInit & { duplex?: 'half' } = {
    method: 'PUT',
    headers,
    body: source.body,
    duplex: 'half',
  };
  const put = await fetch(putUrl, putInit);
  if (put.status !== 201 && put.status !== 204) {
    let detail = '';
    try {
      const body = (await put.json()) as { errors?: { message?: string }[] };
      detail = (body.errors ?? [])
        .map((error) => error.message ?? '')
        .join('; ')
        .slice(0, 200);
    } catch {
      // non-JSON error body
    }
    throw new RegistryMirrorError(`Blob upload of ${digest} failed (${put.status})${detail ? `: ${detail}` : ''}`);
  }

  const uploadedDigest = put.headers.get('docker-content-digest');
  if (uploadedDigest && uploadedDigest !== digest) {
    throw new RegistryMirrorError(`Blob upload digest mismatch for ${digest}: registry reported ${uploadedDigest}`);
  }
};

/** GET a manifest from the source registry (raw bytes + media type). */
const fetchSourceManifest = async (
  repo: string,
  digest: string,
  sourceUrl: string,
  sourceToken: string,
): Promise<ManifestCopy> => {
  const res = await registryFetch(
    `${sourceUrl}/v2/${repo}/manifests/${digest}`,
    { headers: { Accept: MANIFEST_ACCEPT_HEADER, Authorization: `Bearer ${sourceToken}` } },
    `Source manifest fetch ${digest}`,
  );

  const mediaType = res.headers.get('content-type')?.split(';')[0]?.trim();
  if (!mediaType) {
    throw new RegistryMirrorError(`Source manifest ${digest} has no Content-Type`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  return { digest, mediaType, bytes };
};

/** PUT a manifest at the target, byte-identical, verifying the resulting digest. */
const putTargetManifest = async (repo: string, manifest: ManifestCopy, targetToken: string): Promise<void> => {
  const res = await registryFetch(
    `${targetRegistryUrl()}/v2/${repo}/manifests/${manifest.digest}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${targetToken}`,
        'Content-Type': manifest.mediaType,
      },
      body: new Uint8Array(manifest.bytes),
    },
    `Target manifest push ${manifest.digest}`,
  );

  const reported = res.headers.get('docker-content-digest');
  if (reported && reported !== manifest.digest) {
    throw new RegistryMirrorError(
      `Manifest push digest mismatch for ${manifest.digest}: registry reported ${reported}`,
    );
  }
};

/** Verify a manifest digest exists at the target registry. */
export const verifyManifestAtTarget = async (
  repo: string,
  digest: string,
  callerAuthorization: string,
): Promise<boolean> => {
  assertDigest(digest);
  const token = await getTargetToken(repo, callerAuthorization);
  const head = await fetch(`${targetRegistryUrl()}/v2/${repo}/manifests/${digest}`, {
    method: 'HEAD',
    headers: { Accept: MANIFEST_ACCEPT_HEADER, Authorization: `Bearer ${token}` },
  });
  return head.ok;
};

/**
 * Copy an image from the configured source registry into the instance
 * registry, starting at the manifest (list) digest. Recurses into list
 * children and copies every referenced blob; children are pushed before their
 * list. Pulls read `sourceRepo` at the source, writes land at `targetRepo`
 * (defaults to the same path); anonymous sources (ghcr public packages)
 * need no credential.
 */
export const mirrorImageFromSource = async (
  callerAuthorization: string,
  sourceRepo: string,
  digest: string,
  source: SourceRegistryConfig,
  targetRepo = sourceRepo,
): Promise<{ repo: string; digest: string }> => {
  if (
    !/^[a-z0-9][a-z0-9/_-]*$/.test(sourceRepo) ||
    !/^[a-z0-9][a-z0-9/_-]*$/.test(targetRepo) ||
    !/^sha256:[a-f0-9]{64}$/.test(digest)
  ) {
    throw new RegistryMirrorError(`Invalid repository or digest: ${sourceRepo} → ${targetRepo} / ${digest}`);
  }

  return withRepoLock(targetRepo, async () => {
    const sourceToken = await getSourceToken(source, sourceRepo);
    const targetToken = await getTargetToken(targetRepo, callerAuthorization);

    /** Recursively copy a manifest, deduped by digest: children first for lists, blobs before their manifest. */
    const copiedManifests = new Set<string>();
    const copyManifest = async (manifestDigest: string): Promise<void> => {
      assertDigest(manifestDigest);
      if (copiedManifests.has(manifestDigest)) {
        return;
      }
      copiedManifests.add(manifestDigest);

      // Idempotency: a manifest already present at the target needs no copy.
      const head = await fetch(`${targetRegistryUrl()}/v2/${targetRepo}/manifests/${manifestDigest}`, {
        method: 'HEAD',
        headers: { Accept: MANIFEST_ACCEPT_HEADER, Authorization: `Bearer ${targetToken}` },
      });
      if (head.ok) {
        return;
      }
      if (head.status !== 404) {
        throw new RegistryMirrorError(`Target manifest existence check for ${manifestDigest} failed (${head.status})`);
      }

      const manifest = await fetchSourceManifest(sourceRepo, manifestDigest, source.url, sourceToken);
      const inspection = inspectManifest(JSON.parse(manifest.bytes.toString('utf8')));

      if (inspection.isList) {
        // Manifest list / OCI index: copy every child manifest first, then the list itself.
        for (const childDigest of inspection.childManifestDigests) {
          await copyManifest(childDigest);
        }
      } else {
        for (const blobDigest of inspection.blobDigests) {
          await copyBlobIfMissing(sourceRepo, targetRepo, blobDigest, source.url, sourceToken, targetToken);
        }
      }

      await putTargetManifest(targetRepo, manifest, targetToken);
    };

    // For manifest lists: copy each child manifest first, then the list itself.
    await copyManifest(digest);

    return { repo: targetRepo, digest };
  });
};

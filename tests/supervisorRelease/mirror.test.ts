import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, beforeEach } from 'node:test';
import {
  RegistryMirrorError,
  SupervisorTagMissingError,
  UpstreamError,
} from '../../server/controller/supervisorRelease/errors';
import {
  mirrorImageFromSource,
  resetRegistryTokens,
  resolveTagDigest,
  supervisorSourceRegistry,
} from '../../server/controller/supervisorRelease/registryMirror';

/**
 * Full mirror flow against fixture docker manifests, with fetch fully mocked:
 * no network. The source is the anonymous ghcr supervisor mirror (pull token
 * without any credential). Verifies blob existence checks, streamed uploads
 * (POST → Location → PUT ?digest=), manifest-list recursion (children before
 * the list), byte-identical manifest PUTs with the source Content-Type, the
 * digest verification against the registry's docker-content-digest header, and
 * digest-by-tag resolution (header, body-hash fallback, missing tag).
 */

const sha = (char: string): string => `sha256:${char.repeat(64)}`;
const childManifest = {
  schemaVersion: 2,
  mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: 7, digest: sha('a') },
  layers: [{ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: 9, digest: sha('b') }],
};
const manifestList = {
  schemaVersion: 2,
  mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
  manifests: [{ mediaType: childManifest.mediaType, size: 5, digest: sha('c') }],
};

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

const calls: Recorded[] = [];
/** Digests the fake target registry reports as already present (blobs + manifests). */
const presentAtTarget = new Set<string>();
/** Blobs the fake source registry serves. */
const sourceBlobs = new Map<string, string>([
  [sha('a'), 'config-bytes'],
  [sha('b'), 'layer-bytes'],
]);
/** Manifests the fake source registry serves, by digest or by tag. */
const sourceManifests = new Map<string, { bytes: string; contentType: string }>([
  [sha('c'), { bytes: JSON.stringify(childManifest), contentType: childManifest.mediaType }],
  [sha('d'), { bytes: JSON.stringify(manifestList), contentType: manifestList.mediaType }],
]);
/** docker-content-digest the fake source reports on manifest-by-tag GETs. */
let manifestByTagDigest: string | null = sha('d');

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const installFetchMock = (): void => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers((init?.headers as HeadersInit) ?? {}).entries()) as Record<
      string,
      string
    >;
    calls.push({ method, url, headers, body: init?.body });

    // --- token endpoints ---
    // Anonymous source pull token (ghcr-style): no Authorization header is sent.
    if (url.startsWith('https://ghcr.io/token')) {
      return jsonResponse(200, { token: 'source-token' });
    }
    // Instance registry push token, exchanged with the caller's JWT.
    if (url.includes('/auth/v1/token')) {
      const wantsPush = /pull[,|%2C]+push/.test(decodeURIComponent(url));
      return jsonResponse(200, { token: wantsPush ? 'target-token' : 'source-token' });
    }

    // --- source registry (the ghcr supervisor mirror) ---
    if (url.startsWith('https://ghcr.io/')) {
      const tagMatch = /\/manifests\/([^/?]+)$/.exec(url);
      if (tagMatch && !tagMatch[1].startsWith('sha256:')) {
        if (tagMatch[1] === 'v0.0.0-missing') {
          return jsonResponse(404, { errors: [{ message: 'manifest unknown' }] });
        }
        if (!manifestByTagDigest) {
          return new Response('{"schemaVersion":2}', {
            status: 200,
            headers: { 'content-type': childManifest.mediaType },
          });
        }
        return new Response(JSON.stringify(manifestList), {
          status: 200,
          headers: { 'content-type': manifestList.mediaType, 'Docker-Content-Digest': manifestByTagDigest },
        });
      }
      const manifestMatch = /\/manifests\/(sha256:[a-f0-9]+)$/.exec(url);
      if (manifestMatch) {
        const manifest = sourceManifests.get(manifestMatch[1]);
        if (!manifest) {
          return jsonResponse(404, { errors: [{ message: 'manifest unknown' }] });
        }
        return new Response(manifest.bytes, {
          status: 200,
          headers: { 'content-type': manifest.contentType },
        });
      }
      const blobMatch = /\/blobs\/(sha256:[a-f0-9]+)$/.exec(url);
      if (blobMatch) {
        const blob = sourceBlobs.get(blobMatch[1]);
        if (!blob) {
          return jsonResponse(404, { errors: [{ message: 'blob unknown' }] });
        }
        return new Response(blob, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(blob.length) },
        });
      }
    }

    // --- target registry (instance) ---
    if (url.includes('/v2/') && url.includes('registry2.balena.example.com')) {
      if (method === 'HEAD') {
        const digest = /(?:blobs|manifests)\/(sha256:[a-f0-9]+)$/.exec(url)?.[1];
        return new Response(null, { status: presentAtTarget.has(digest ?? '') ? 200 : 404 });
      }
      if (method === 'POST' && url.endsWith('/blobs/uploads/')) {
        // Relative Location on a path — exercises the redirect resolution.
        return new Response(null, {
          status: 202,
          headers: { location: '/v2/r1/blobs/uploads/upload-1?_state=abc123' },
        });
      }
      if (method === 'PUT') {
        if (url.includes('/blobs/uploads/')) {
          const digest = /digest=(sha256:[a-f0-9]+)/.exec(url)?.[1] ?? '';
          presentAtTarget.add(digest);
          return new Response(null, { status: 201, headers: { 'docker-content-digest': digest } });
        }
        if (url.includes('/manifests/')) {
          const digest = /manifests\/(sha256:[a-f0-9]+)$/.exec(url)?.[1] ?? '';
          presentAtTarget.add(digest);
          return new Response(null, { status: 201, headers: { 'docker-content-digest': digest } });
        }
      }
    }

    return jsonResponse(500, { errors: [{ message: `unmocked ${method} ${url}` }] });
  }) as typeof fetch;
};

const restoreFetch = (): void => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  delete (globalThis as { fetch?: typeof fetch }).fetch;
};

beforeEach(() => {
  calls.length = 0;
  presentAtTarget.clear();
  manifestByTagDigest = sha('d');
  resetRegistryTokens();
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.balena.example.com';
  delete process.env.OPEN_BALENA_REGISTRY_URL;
  delete process.env.SUPERVISOR_SOURCE_REGISTRY;
});

test('mirror copies list children and their blobs before the list, byte-identical', async () => {
  installFetchMock();
  try {
    const result = await mirrorImageFromSource('Bearer caller', 'r1', sha('d'), supervisorSourceRegistry());

    assert.deepEqual(result, { repo: 'r1', digest: sha('d') });

    const methods = calls.map((call) => `${call.method} ${call.url.split('example.com').pop() ?? call.url}`);
    const childManifestPut = methods.findIndex((entry) => entry === `PUT /v2/r1/manifests/${sha('c')}`);
    const listPut = methods.findIndex((entry) => entry === `PUT /v2/r1/manifests/${sha('d')}`);
    const blobUploads = methods.filter((entry) => entry.startsWith('PUT /v2/r1/blobs/uploads/'));

    // Children before the list, and both blob uploads happened exactly once.
    assert.ok(childManifestPut > -1, 'child manifest is pushed');
    assert.ok(listPut > childManifestPut, 'manifest list is pushed after its child');
    assert.equal(blobUploads.length, 2, 'config + layer are uploaded');

    // Blobs streamed via the upload session with the digest query parameter.
    for (const upload of blobUploads) {
      assert.match(upload, /digest=sha256%3A[0-9a-f]{64}/);
    }

    // Manifest PUTs are byte-identical: the exact fixture bytes with the source Content-Type.
    const listPutCall = calls.find((call) => call.method === 'PUT' && call.url.endsWith(`/manifests/${sha('d')}`))!;
    assert.equal(listPutCall.headers['content-type'], manifestList.mediaType);
    const putBody =
      typeof listPutCall.body === 'string'
        ? listPutCall.body
        : new TextDecoder().decode(listPutCall.body as Uint8Array);
    assert.equal(putBody, JSON.stringify(manifestList));

    // Pulls authenticated with the anonymous source token, pushes with the caller-derived target token.
    const sourceManifestGet = calls.find(
      (call) => call.method === 'GET' && call.url.includes(`ghcr.io/v2/r1/manifests/${sha('c')}`),
    )!;
    assert.equal(sourceManifestGet.headers['authorization'], 'Bearer source-token');
    assert.equal(listPutCall.headers['authorization'], 'Bearer target-token');
  } finally {
    restoreFetch();
  }
});

test('source pull tokens are fetched anonymously (no credential sent)', async () => {
  installFetchMock();
  try {
    await mirrorImageFromSource('Bearer caller', 'r1', sha('d'), supervisorSourceRegistry());

    const tokenRequest = calls.find((call) => call.url.startsWith('https://ghcr.io/token'))!;
    assert.ok(tokenRequest, 'anonymous token endpoint is called');
    assert.equal(tokenRequest.headers['authorization'], undefined, 'no Authorization header on the token request');
    assert.match(tokenRequest.url, /scope=repository%3Ar1%3Apull/);
  } finally {
    restoreFetch();
  }
});

test('already-present blobs are skipped and manifests are not re-pushed', async () => {
  presentAtTarget.add(sha('a'));
  presentAtTarget.add(sha('b'));
  presentAtTarget.add(sha('c'));
  presentAtTarget.add(sha('d'));

  installFetchMock();
  try {
    await mirrorImageFromSource('Bearer caller', 'r1', sha('d'), supervisorSourceRegistry());

    const targetWrites = calls.filter(
      (call) => call.url.includes('registry2.balena.example.com') && (call.method === 'PUT' || call.method === 'POST'),
    );
    assert.equal(targetWrites.length, 0, 'nothing is written when everything exists');
  } finally {
    restoreFetch();
  }
});

test('blob uploads follow the upload session Location (relative path, absolute URL)', async () => {
  installFetchMock();
  try {
    await mirrorImageFromSource('Bearer caller', 'r1', sha('c'), supervisorSourceRegistry());

    const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/v2/r1/blobs/uploads/'));
    const put = calls.find((call) => call.method === 'PUT' && call.url.includes('/blobs/uploads/'));

    assert.ok(post, 'upload session is initiated');
    assert.ok(put, 'upload is completed');
    assert.equal(
      new URL(put!.url).host,
      'registry2.balena.example.com',
      'relative Location resolved against the target host',
    );
    assert.match(put!.url, /\/v2\/r1\/blobs\/uploads\/upload-1/);
    assert.match(put!.url, /_state=abc123/);
  } finally {
    restoreFetch();
  }
});

test('resolveTagDigest takes the docker-content-digest header (case-insensitive)', async () => {
  installFetchMock();
  try {
    // The mock answers the header as `Docker-Content-Digest`; fetch reads case-insensitively.
    const digest = await resolveTagDigest('r1', 'v19.0.8', supervisorSourceRegistry());
    assert.equal(digest, sha('d'));

    const manifestGet = calls.find((call) => call.method === 'GET' && call.url.endsWith('/v2/r1/manifests/v19.0.8'))!;
    assert.ok(manifestGet, 'manifest is fetched by the tag as listed');
    assert.match(manifestGet.headers['accept'] ?? '', /manifest\.list\.v2\+json/);
    assert.equal(manifestGet.headers['authorization'], 'Bearer source-token');
  } finally {
    restoreFetch();
  }
});

test('resolveTagDigest falls back to the sha256 of the raw body when the header is absent', async () => {
  manifestByTagDigest = null; // registry omits docker-content-digest
  installFetchMock();
  try {
    const digest = await resolveTagDigest('r1', '19.0.8', supervisorSourceRegistry());
    assert.equal(digest, `sha256:${createHash('sha256').update('{"schemaVersion":2}').digest('hex')}`);
  } finally {
    restoreFetch();
  }
});

test('a present-but-malformed docker-content-digest falls back to the body hash', async () => {
  manifestByTagDigest = 'garbage'; // header present, but not a digest
  installFetchMock();
  try {
    const digest = await resolveTagDigest('r1', '19.0.8', supervisorSourceRegistry());
    assert.equal(digest, `sha256:${createHash('sha256').update(JSON.stringify(manifestList)).digest('hex')}`);
  } finally {
    restoreFetch();
  }
});

test('a missing tag raises the actionable tag-missing error', async () => {
  installFetchMock();
  try {
    await assert.rejects(
      () => resolveTagDigest('r1', 'v0.0.0-missing', supervisorSourceRegistry()),
      SupervisorTagMissingError,
    );
  } finally {
    restoreFetch();
  }
});

test('a network-level manifest failure is an upstream error naming the source registry', async () => {
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    if (String(input).startsWith('https://ghcr.io/token')) {
      return jsonResponse(200, { token: 'source-token' });
    }
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => resolveTagDigest('r1', 'v19.0.8', supervisorSourceRegistry()),
      (error: unknown) =>
        error instanceof UpstreamError &&
        error.message.includes('Source registry manifest request failed: cannot reach https://ghcr.io'),
    );
  } finally {
    restoreFetch();
  }
});

test('a failing manifest endpoint raises an upstream error naming the source', async () => {
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
  try {
    await assert.rejects(
      () => resolveTagDigest('r1', 'v19.0.8', supervisorSourceRegistry()),
      (error: unknown) => error instanceof UpstreamError && error.message.includes('ghcr.io'),
    );
  } finally {
    restoreFetch();
  }
});

test('hostile digests inside manifest JSON are rejected before any registry call', async () => {
  const { inspectManifest } = await import('../../server/controller/supervisorRelease/registryMirror');

  // Manifest list with a traversal digest in a child entry
  const hostileList = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
    manifests: [{ mediaType: 'application/vnd.docker.distribution.manifest.v2+json', size: 7, digest: '../../evil' }],
  };
  assert.throws(() => inspectManifest(hostileList), RegistryMirrorError);

  // Single manifest with a hostile config digest
  const hostileManifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { digest: 'sha256:short' },
    layers: [{ digest: 'http://attacker/x' }],
  };
  assert.throws(() => inspectManifest(hostileManifest), RegistryMirrorError);

  // Entry point still rejects traversal digests outright (no fetch performed)
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      mirrorImageFromSource('Bearer caller', 'a/b', '../../evil', supervisorSourceRegistry()),
      RegistryMirrorError,
    );
    await assert.rejects(
      mirrorImageFromSource('Bearer caller', 'a/b', 'sha256:xyz', supervisorSourceRegistry()),
      RegistryMirrorError,
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetRegistryTokens();
  }
});

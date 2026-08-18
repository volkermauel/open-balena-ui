import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { MirroringNotConfiguredError } from '../../server/controller/supervisorRelease/errors';
import { mirrorImage, resetRegistryTokens } from '../../server/controller/supervisorRelease/registryMirror';

/**
 * Full mirror flow against fixture docker manifests, with fetch fully mocked:
 * no network. Verifies blob existence checks, streamed uploads (POST →
 * Location → PUT ?digest=), manifest-list recursion (children before the
 * list), byte-identical manifest PUTs with the source Content-Type, and the
 * digest verification against the registry's docker-content-digest header.
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
/** Manifests the fake source registry serves, by digest. */
const sourceManifests = new Map<string, { bytes: string; contentType: string }>([
  [sha('c'), { bytes: JSON.stringify(childManifest), contentType: childManifest.mediaType }],
  [sha('d'), { bytes: JSON.stringify(manifestList), contentType: manifestList.mediaType }],
]);

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
    if (url.includes('/auth/v1/token')) {
      const isSource = url.includes('api.balena-cloud.com');
      if (isSource && !process.env.BALENACLOUD_TOKEN) {
        return jsonResponse(401, {});
      }
      const wantsPush = /pull[,|%2C]+push/.test(decodeURIComponent(url));
      return jsonResponse(200, { token: wantsPush ? 'target-token' : 'source-token' });
    }

    // --- source registry (registry2.balena-cloud.com) ---
    if (url.startsWith('https://registry2.balena-cloud.com/')) {
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
  resetRegistryTokens();
  process.env.BALENACLOUD_TOKEN = 'cloud-jwt';
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.balena.example.com';
  delete process.env.OPEN_BALENA_REGISTRY_URL;
});

test('mirroring without BALENACLOUD_TOKEN raises the typed not-configured error', async () => {
  delete process.env.BALENACLOUD_TOKEN;
  await assert.rejects(() => mirrorImage('Bearer caller', 'r1', sha('d')), MirroringNotConfiguredError);
});

test('mirror copies list children and their blobs before the list, byte-identical', async () => {
  installFetchMock();
  try {
    const result = await mirrorImage('Bearer caller', 'r1', sha('d'));

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

    // Pulls authenticated with the server token, pushes with the caller-derived target token.
    const sourceManifestGet = calls.find(
      (call) => call.method === 'GET' && call.url.includes(`registry2.balena-cloud.com/v2/r1/manifests/${sha('c')}`),
    )!;
    assert.equal(sourceManifestGet.headers['authorization'], 'Bearer source-token');
    assert.equal(listPutCall.headers['authorization'], 'Bearer target-token');
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
    await mirrorImage('Bearer caller', 'r1', sha('d'));

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
    await mirrorImage('Bearer caller', 'r1', sha('c'));

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

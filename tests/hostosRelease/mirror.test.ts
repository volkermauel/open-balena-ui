import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { mirrorImageFromSource, resetRegistryTokens } from '../../server/controller/supervisorRelease/registryMirror';
import { hostosSource, hostosSourceRegistryConfig, sourceRepo } from '../../server/controller/hostosRelease/catalog';
import { hostosCommit } from '../../server/controller/hostosRelease/instance';
import { seedHostosRelease } from '../../server/controller/hostosRelease/seed';

/**
 * Full hostOS import flow against fixture data with fetch fully mocked: no
 * network. Verifies the ghcr anonymous-token path (NO credential on the token
 * request, Bearer pull tokens afterwards), the mirror's digest-preserving
 * copies, the crash-safe creation order (image → mirror → release → link →
 * version tag) and the idempotent re-import short-circuit (no writes at all).
 */

const sha = (char: string): string => `sha256:${char.repeat(64)}`;
const MACHINE = 'raspberrypi4-64';
const SOURCE_REPO = 'volkermauel/balenaos-hostapp/raspberrypi4-64';
const TARGET_REPO = `balenaos-hostapp/${MACHINE}`;
/** Repo the instance's image-is-stored-at-location hook assigns on create. */
const ASSIGNED_REPO = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const hostappManifest = {
  schemaVersion: 2,
  mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: 7, digest: sha('a') },
  layers: [{ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: 9, digest: sha('b') }],
};

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

const calls: Recorded[] = [];
/** Digests the fake target registry reports as already present. */
const presentAtTarget = new Set<string>();
/** Instance rows the fake instance API serves. */
const instanceState = {
  application: { id: 99 },
  service: { id: 55 },
  releases: [] as { id: number; raw_version: string; semver: string }[],
  imageByHash: null as { id: number; serviceId: number; location?: string } | null,
  releaseImages: [] as number[],
  releaseTag: false,
};

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const instanceGet = (url: string): Response | null => {
  if (!url.includes('api.balena.example.com')) {
    return null;
  }
  if (url.includes('/auth/v1/token')) {
    return jsonResponse(200, { token: 'target-token' });
  }
  if (url.includes('/device_type')) {
    return jsonResponse(200, {
      d: [{ id: 5, slug: MACHINE, is_of__cpu_architecture: [{ slug: 'aarch64' }] }],
    });
  }
  if (url.includes('/application')) {
    return jsonResponse(200, { d: [instanceState.application] });
  }
  if (url.includes('/service')) {
    return jsonResponse(200, { d: [instanceState.service] });
  }
  if (url.includes('/release_tag')) {
    return jsonResponse(200, { d: instanceState.releaseTag ? [{ id: 9, value: '7.4.0+rev5' }] : [] });
  }
  if (url.includes('/release_image')) {
    return jsonResponse(200, { d: instanceState.releaseImages.map((imageId) => ({ image: { __id: imageId } })) });
  }
  if (url.includes('/release')) {
    // Field probes ($select=raw_version / $select=is_final) answer ok; the
    // release list returns the configured rows.
    if (url.includes('$select=raw_version') || url.includes('$select=is_final')) {
      return jsonResponse(200, { d: [] });
    }
    return jsonResponse(200, { d: instanceState.releases });
  }
  if (url.includes('/image')) {
    // location comes from the row: the hook-assigned repo once created
    const location = `registry2.balena.example.com/v2/${instanceState.imageByHash?.location ?? TARGET_REPO}`;
    return jsonResponse(200, {
      d: instanceState.imageByHash
        ? [
            {
              id: instanceState.imageByHash.id,
              is_a_build_of__service: { __id: instanceState.imageByHash.serviceId },
              is_stored_at__image_location: location,
              content_hash: sha('e'),
            },
          ]
        : [],
    });
  }
  return jsonResponse(500, { Error: { text: `unmocked instance GET ${url}` } });
};

const installFetchMock = (): void => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers((init?.headers as HeadersInit) ?? {}).entries()) as Record<
      string,
      string
    >;
    calls.push({ method, url, headers, body: init?.body });

    // --- ghcr source: anonymous token, then catalog + registry pulls ---
    if (url.startsWith('https://ghcr.io/token')) {
      assert.equal(headers['authorization'], undefined, 'anonymous token request carries no Authorization header');
      return jsonResponse(200, { token: 'ghcr-token' });
    }
    if (url.startsWith(`https://ghcr.io/v2/${SOURCE_REPO}/tags/list`)) {
      return jsonResponse(200, { name: SOURCE_REPO, tags: ['19.0.8', '7.4.0-rev5'] });
    }
    if (url === `https://ghcr.io/v2/${SOURCE_REPO}/manifests/7.4.0-rev5` && method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'docker-content-digest': sha('e') } });
    }
    if (url.startsWith(`https://ghcr.io/v2/${SOURCE_REPO}/manifests/${sha('e')}`)) {
      return new Response(JSON.stringify(hostappManifest), {
        status: 200,
        headers: { 'content-type': hostappManifest.mediaType },
      });
    }
    if (url === `https://ghcr.io/v2/${SOURCE_REPO}/blobs/${sha('a')}`) {
      return new Response('config-bytes', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '12' },
      });
    }
    if (url === `https://ghcr.io/v2/${SOURCE_REPO}/blobs/${sha('b')}`) {
      return new Response('layer-bytes', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '11' },
      });
    }

    // --- instance API (api.balena.example.com): POST creates before GET lookups ---
    if (url.startsWith('https://api.balena.example.com/v6/') && method === 'POST') {
      const resource = /\/v6\/([a-z_]+)/.exec(url)?.[1] ?? 'unknown';
      const ids: Record<string, number> = { image: 11, release: 42, release_image: 77, release_tag: 9 };
      if (resource === 'image') {
        // Simulate the image-is-stored-at-location hook: the POSTED location is
        // overwritten server-side with a random repo — the read-back sees it.
        instanceState.imageByHash = { id: ids.image, serviceId: 55, location: ASSIGNED_REPO };
      }
      // pinejs POST with Prefer: return=representation answers with the created row itself
      return jsonResponse(200, { id: ids[resource] ?? 1 });
    }
    const instanceGetResponse = instanceGet(url);
    if (instanceGetResponse) {
      return instanceGetResponse;
    }

    // --- target registry (registry2.balena.example.com) ---
    if (url.includes('registry2.balena.example.com')) {
      if (method === 'HEAD') {
        const digest = /(?:blobs|manifests)\/(sha256:[a-f0-9]+)$/.exec(url)?.[1];
        return new Response(null, { status: presentAtTarget.has(digest ?? '') ? 200 : 404 });
      }
      if (method === 'POST' && url.endsWith('/blobs/uploads/')) {
        const uploadRepo = /\/v2\/(.+)\/blobs\/uploads\//.exec(url)?.[1] ?? TARGET_REPO;
        return new Response(null, {
          status: 202,
          headers: { location: `/v2/${uploadRepo}/blobs/uploads/upload-1?_state=abc123` },
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

    return jsonResponse(500, { Error: { text: `unmocked ${method} ${url}` } });
  }) as typeof fetch;
};

const restoreFetch = (): void => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
};

const posts = (): Recorded[] => calls.filter((call) => call.method === 'POST');
const ghcrPulls = (): Recorded[] =>
  calls.filter((call) => call.url.startsWith('https://ghcr.io/v2/') && call.method !== 'HEAD');

beforeEach(() => {
  calls.length = 0;
  presentAtTarget.clear();
  instanceState.releases = [];
  instanceState.imageByHash = null;
  instanceState.releaseImages = [];
  instanceState.releaseTag = false;
  resetRegistryTokens();
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.balena.example.com';
  delete process.env.OPEN_BALENA_REGISTRY_URL;
  delete process.env.HOSTOS_SOURCE_REGISTRY;
});

test('mirrorImageFromSource copies from an anonymous source without any credential', async () => {
  installFetchMock();
  try {
    const sourceRepository = sourceRepo(hostosSource(), MACHINE);
    const result = await mirrorImageFromSource(
      'Bearer caller',
      sourceRepository,
      sha('e'),
      hostosSourceRegistryConfig(hostosSource()),
      TARGET_REPO,
    );

    assert.deepEqual(result, { repo: TARGET_REPO, digest: sha('e') });

    const tokenRequest = calls.find((call) => call.url.startsWith('https://ghcr.io/token'))!;
    assert.ok(tokenRequest, 'anonymous token is requested');
    assert.equal(tokenRequest.headers['authorization'], undefined);
    assert.match(tokenRequest.url, /scope=repository%3Avolkermauel%2Fbalenaos-hostapp%2Fraspberrypi4-64%3Apull/);

    // Registry pulls carry the anonymous Bearer token.
    for (const pull of ghcrPulls()) {
      assert.equal(pull.headers['authorization'], 'Bearer ghcr-token');
    }

    // The manifest lands byte-identical with the source Content-Type.
    const manifestPut = calls.find((call) => call.method === 'PUT' && call.url.endsWith(`/manifests/${sha('e')}`))!;
    assert.equal(manifestPut.headers['content-type'], hostappManifest.mediaType);
    assert.equal(manifestPut.headers['authorization'], 'Bearer target-token');
  } finally {
    restoreFetch();
  }
});

test('a cold import creates image, release and link, then mirrors and tags in order', async () => {
  installFetchMock();
  try {
    const result = await seedHostosRelease({ authorization: 'Bearer caller' }, MACHINE, '7.4.0+rev5');

    assert.deepEqual(result, {
      appId: 99,
      releaseId: 42,
      image: { repo: ASSIGNED_REPO, digest: sha('e') },
    });

    const instancePosts = posts().filter((call) => call.url.includes('api.balena.example.com'));
    assert.deepEqual(
      instancePosts.map((call) => /\/v6\/([a-z_]+)/.exec(call.url)?.[1]),
      ['image', 'release', 'release_image', 'release_tag'],
    );

    const imagePost = instancePosts[0];
    const imageBody = JSON.parse(String(imagePost.body));
    assert.equal(imageBody.is_a_build_of__service, 55);
    assert.equal(imageBody.is_stored_at__image_location, `registry2.balena.example.com/v2/${TARGET_REPO}`);
    assert.equal(imageBody.content_hash, sha('e'));
    assert.equal(imageBody.status, 'success');
    assert.equal(typeof imageBody.start_timestamp, 'string');

    // The location was read back after the hook's overwrite…
    const readBack = calls.find((call) => call.url.includes('/image') && call.url.includes('$filter=id%20eq%2011'));
    assert.ok(readBack, 'image location is read back after creation');
    // …and every registry write went to the ASSIGNED repo, never the intended one.
    const registryWrites = calls.filter(
      (call) =>
        call.url.includes('registry2.balena.example.com/v2/') && (call.method === 'PUT' || call.method === 'POST'),
    );
    assert.ok(registryWrites.length > 0);
    for (const write of registryWrites) {
      assert.ok(write.url.includes(`/v2/${ASSIGNED_REPO}/`), `write hit the assigned repo: ${write.url}`);
    }

    const releasePost = instancePosts[1];
    const releaseBody = JSON.parse(String(releasePost.body));
    assert.equal(releaseBody.belongs_to__application, 99);
    assert.equal(releaseBody.raw_version, '7.4.0-rev5');
    assert.equal(releaseBody.semver, '7.4.0+rev5');
    assert.equal(releaseBody.is_final, false);
    assert.equal(releaseBody.status, 'success');
    assert.equal(releaseBody.commit, hostosCommit(MACHINE, '7.4.0-rev5'));
    assert.equal(typeof releaseBody.start_timestamp, 'string');
    assert.equal(typeof releaseBody.update_timestamp, 'string');

    assert.deepEqual(JSON.parse(String(instancePosts[2].body)), { release: 42, image: 11 });
    assert.deepEqual(JSON.parse(String(instancePosts[3].body)), {
      release: 42,
      tag_key: 'version',
      value: '7.4.0+rev5',
    });

    // The mirror ran after the release POST — the API grants registry `pull` only
    // once the image is linked to a release, so bytes can only follow the link.
    const manifestPut = calls.find((call) => call.method === 'PUT' && call.url.includes(`/manifests/${sha('e')}`))!;
    assert.ok(
      calls.indexOf(releasePost) < calls.indexOf(manifestPut),
      'the release row is created before the image bytes are mirrored',
    );
    const tokenRequest = calls.find((call) => call.url.startsWith('https://ghcr.io/token'))!;
    assert.equal(tokenRequest.headers['authorization'], undefined);
    const tagsList = calls.find((call) => call.url.includes('/tags/list'))!;
    assert.equal(tagsList.headers['authorization'], 'Bearer ghcr-token');
  } finally {
    restoreFetch();
  }
});

test('an already imported version short-circuits with no writes at all', async () => {
  instanceState.releases = [{ id: 42, raw_version: '7.4.0-rev5', semver: '7.4.0+rev5' }];
  instanceState.imageByHash = { id: 11, serviceId: 55, location: ASSIGNED_REPO };
  instanceState.releaseImages = [11];
  instanceState.releaseTag = true;
  presentAtTarget.add(sha('e'));

  installFetchMock();
  try {
    const result = await seedHostosRelease({ authorization: 'Bearer caller' }, MACHINE, '7.4.0+rev5');

    assert.equal(result.releaseId, 42);
    assert.equal(posts().length, 0, 'no registry or instance writes on re-import');
    assert.equal(
      calls.some(
        (call) =>
          call.url.includes('ghcr.io/v2/') &&
          call.method === 'GET' &&
          (call.url.includes('/manifests/') || call.url.includes('/blobs/')),
      ),
      false,
      'no image bytes are pulled from the source',
    );
  } finally {
    restoreFetch();
  }
});

test('an unknown version for a known device type is a 404-style NotFoundError', async () => {
  installFetchMock();
  try {
    const { NotFoundError } = await import('../../server/controller/hostosRelease/errors');
    await assert.rejects(seedHostosRelease({ authorization: 'Bearer caller' }, MACHINE, '1.2.3'), NotFoundError);
  } finally {
    restoreFetch();
  }
});

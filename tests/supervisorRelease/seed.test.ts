import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { planSeedSteps, repoFromLocation, seedSupervisorRelease } from '../../server/controller/supervisorRelease/seed';
import { resetRegistryTokens } from '../../server/controller/supervisorRelease/registryMirror';
import { aggregateResults, DeviceUpdateResult } from '../../server/controller/supervisorRelease/update';
import { isDowngrade, isSameSupervisorVersion } from '../../src/lib/supervisorRelease';

const completeState = {
  appId: 7,
  releaseId: 42,
  existingServiceNames: ['core'],
  existingImageHashes: ['sha256:' + 'a'.repeat(64)],
  existingReleaseImageIds: [101],
  releaseLinksCurrentImages: true,
  bytesVerified: true,
};

test('a fully seeded version plans no work', () => {
  assert.deepEqual(
    planSeedSteps(completeState, {
      serviceNames: ['core'],
      imageHashes: ['sha256:' + 'a'.repeat(64)],
      imageCount: 1,
    }),
    ['complete'],
  );
});

test('a cold seed plans every step in link-before-mirror order', () => {
  const steps = planSeedSteps(
    {
      existingServiceNames: [],
      existingImageHashes: [],
      existingReleaseImageIds: [],
      releaseLinksCurrentImages: false,
      bytesVerified: false,
    },
    { serviceNames: ['core', 'service-relay'], imageHashes: ['sha256:x', 'sha256:y'], imageCount: 2 },
  );

  assert.deepEqual(steps, [
    'create-app',
    'create-service',
    'create-image-metadata',
    'create-release',
    'create-release-image',
    'mirror-bytes',
  ]);
});

test('metadata existing but bytes unverified still mirrors after the release link', () => {
  const steps = planSeedSteps(
    { ...completeState, releaseId: undefined, bytesVerified: false, existingReleaseImageIds: [] },
    { serviceNames: ['core'], imageHashes: ['sha256:' + 'a'.repeat(64)], imageCount: 1 },
  );

  assert.deepEqual(steps, ['create-release', 'create-release-image', 'mirror-bytes']);
});

test('a crashed seed resumes: bytes there, release missing', () => {
  const steps = planSeedSteps(
    { ...completeState, releaseId: undefined, existingReleaseImageIds: [] },
    { serviceNames: ['core'], imageHashes: ['sha256:' + 'a'.repeat(64)], imageCount: 1 },
  );

  assert.deepEqual(steps, ['create-release', 'create-release-image']);
});

test('release present but not all images linked finishes the links', () => {
  const steps = planSeedSteps(
    {
      ...completeState,
      existingServiceNames: ['core', 'service-relay'],
      existingImageHashes: ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64)],
      existingReleaseImageIds: [101],
    },
    {
      serviceNames: ['core', 'service-relay'],
      imageHashes: ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64)],
      imageCount: 2,
    },
  );

  assert.deepEqual(steps, ['create-release-image']);
});

test('missing release_image links are detected by count', () => {
  const steps = planSeedSteps(
    { ...completeState, existingReleaseImageIds: [] },
    { serviceNames: ['core'], imageHashes: ['sha256:' + 'a'.repeat(64)], imageCount: 1 },
  );

  assert.deepEqual(steps, ['create-release-image']);
});

test('a digest change re-seeds metadata, links the new image, then mirrors bytes', () => {
  const steps = planSeedSteps(
    {
      appId: 7,
      releaseId: 42,
      existingServiceNames: ['supervisor'],
      existingImageHashes: [],
      existingReleaseImageIds: [101], // still the OLD image
      releaseLinksCurrentImages: false, // the tag now resolves to a new digest
      bytesVerified: false,
    },
    { serviceNames: ['supervisor'], imageHashes: ['sha256:' + 'c'.repeat(64)], imageCount: 1 },
  );

  assert.deepEqual(steps, ['create-image-metadata', 'create-release-image', 'mirror-bytes']);
});

test('repo names are extracted from balenaCloud image locations', () => {
  assert.equal(
    repoFromLocation('registry2.balena-cloud.com/v2/830e5bb7294e5583620451186e08b5de'),
    '830e5bb7294e5583620451186e08b5de',
  );
  assert.throws(() => repoFromLocation('example.com/some/repo'));
});

test('bulk aggregation counts updated and rejected devices', () => {
  const results: DeviceUpdateResult[] = [
    { id: 1, ok: true },
    { id: 2, ok: false, message: 'Attempt to downgrade supervisor, which is not allowed' },
    { id: 3, ok: true },
  ];

  assert.deepEqual(aggregateResults(results), { total: 3, updated: 2, rejected: 1 });
  assert.deepEqual(aggregateResults([]), { total: 0, updated: 0, rejected: 0 });
});

test('downgrade pre-filter marks versions older than the current one', () => {
  assert.equal(isDowngrade('19.0.8', '19.0.9'), true);
  assert.equal(isDowngrade('19.0.9', '19.0.9'), false);
  assert.equal(isDowngrade('19.0.10', '19.0.9'), false);
  assert.equal(isDowngrade('20.0.0', '19.0.9'), false);
  assert.equal(isDowngrade('19.0.9', null), false);
  assert.equal(isDowngrade('19.0.9', undefined), false);
});

test('raw-version suffixes compare equal to their semver', () => {
  assert.equal(isDowngrade('19.0.9', '19.0.9-1786970539365'), false);
  assert.equal(isSameSupervisorVersion('19.0.9', '19.0.9-1786970539365'), true);
  assert.equal(isSameSupervisorVersion('19.0.9', '19.0.10'), false);
  assert.equal(isSameSupervisorVersion('19.0.9', null), false);
});

// ---------------------------------------------------------------------------
// Imperative seed flow (fetch fully mocked: ghcr source, instance API,
// instance registry — no network). Mirrors the hostosRelease seed tests.
// ---------------------------------------------------------------------------

const sha = (char: string): string => `sha256:${char.repeat(64)}`;
const MACHINE = 'raspberrypi4-64';
const SOURCE_REPO = 'volkermauel/aarch64-supervisor';
/** Repo the instance's image-is-stored-at-location hook assigns on create. */
const ASSIGNED_REPO = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const supervisorManifest = (rev: number): string =>
  JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: 7, digest: sha('a') },
    layers: [{ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: 9, digest: sha('b') }],
    annotations: { rev: String(rev) },
  });

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

const seedCalls: Recorded[] = [];
/** Digests the fake target registry reports as already present. */
const presentAtTarget = new Set<string>();
/** Instance rows + source manifests the mocks serve. */
const seedState = {
  /** docker-content-digest the fake source reports for the tag manifest. */
  tagDigest: sha('d'),
  manifestByDigest: new Map<string, string>([
    [sha('d'), supervisorManifest(1)],
    [sha('f'), supervisorManifest(2)],
  ]),
  application: null as { id: number } | null,
  services: [] as { id: number; name: string }[],
  releases: [] as { id: number; rawVersion: string; semver: string }[],
  images: [] as { id: number; hash: string; serviceId: number }[],
  releaseImages: [] as { release: number; image: number }[],
};

const seedJsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const installSeedFetchMock = (): void => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers((init?.headers as HeadersInit) ?? {}).entries()) as Record<
      string,
      string
    >;
    seedCalls.push({ method, url, headers, body: init?.body });

    // --- ghcr source: anonymous token, tags, manifest by tag/digest, blobs ---
    if (url.startsWith('https://ghcr.io/token')) {
      return seedJsonResponse(200, { token: 'ghcr-token' });
    }
    if (url === `https://ghcr.io/v2/${SOURCE_REPO}/tags/list?n=1000`) {
      return seedJsonResponse(200, { name: SOURCE_REPO, tags: ['v19.0.8'] });
    }
    if (url === `https://ghcr.io/v2/${SOURCE_REPO}/manifests/v19.0.8`) {
      return new Response(seedState.manifestByDigest.get(seedState.tagDigest), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.docker.distribution.manifest.v2+json',
          'Docker-Content-Digest': seedState.tagDigest,
        },
      });
    }
    const digestMatch = /\/manifests\/(sha256:[a-f0-9]+)$/.exec(url);
    if (digestMatch && url.startsWith('https://ghcr.io/')) {
      const bytes = seedState.manifestByDigest.get(digestMatch[1]);
      if (!bytes) {
        return seedJsonResponse(404, { errors: [{ message: 'manifest unknown' }] });
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/vnd.docker.distribution.manifest.v2+json' },
      });
    }
    if (url.startsWith('https://ghcr.io/v2/') && url.includes('/blobs/sha256:')) {
      return new Response('blob-bytes', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '10' },
      });
    }

    // --- instance API: POST creates rows, GET lookups see them ---
    if (url.startsWith('https://api.balena.example.com/v6/') && method === 'POST') {
      const resource = /\/v6\/([a-z_]+)/.exec(url)?.[1] ?? 'unknown';
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (resource === 'image') {
        // Simulate the image-is-stored-at-location hook: the location is
        // assigned server-side; the read-back sees the assigned repo.
        const id = 11 + seedState.images.length;
        seedState.images.push({
          id,
          hash: String(body.content_hash),
          serviceId: Number(body.is_a_build_of__service),
        });
        return seedJsonResponse(200, { id });
      }
      if (resource === 'release') {
        seedState.releases.push({
          id: 42,
          rawVersion: String(body.raw_version),
          semver: `${body.semver_major}.${body.semver_minor}.${body.semver_patch}`,
        });
        return seedJsonResponse(200, { id: 42 });
      }
      if (resource === 'release_image') {
        seedState.releaseImages.push({ release: Number(body.release), image: Number(body.image) });
        return seedJsonResponse(200, { id: 77 });
      }
      if (resource === 'service') {
        const id = 55;
        seedState.services.push({ id, name: String(body.service_name) });
        return seedJsonResponse(200, { id });
      }
      if (resource === 'application') {
        seedState.application = { id: 99 };
        return seedJsonResponse(200, { id: 99 });
      }
      return seedJsonResponse(200, { id: 1 }); // organization
    }
    if (url.startsWith('https://api.balena.example.com')) {
      if (url.includes('/auth/v1/token')) {
        return seedJsonResponse(200, { token: 'target-token' });
      }
      if (url.includes('/device_type')) {
        return seedJsonResponse(200, {
          d: [{ id: 5, slug: MACHINE, is_of__cpu_architecture: [{ slug: 'aarch64' }] }],
        });
      }
      if (url.includes('/organization')) {
        return seedJsonResponse(200, { d: [] });
      }
      if (url.includes('/application_type')) {
        return seedJsonResponse(200, { d: [{ id: 2, name: 'App', slug: 'default' }] });
      }
      if (url.includes('/application') && url.includes('$select=slug')) {
        // Slug read-back after the app POST hook.
        return seedJsonResponse(200, { d: [{ slug: 'balena_os/aarch64-supervisor' }] });
      }
      if (url.includes('/application')) {
        return seedJsonResponse(200, { d: seedState.application ? [seedState.application] : [] });
      }
      if (url.includes('/service')) {
        const name = /service_name%20eq%20'([a-z_-]+)'/.exec(url)?.[1] ?? '';
        const service = seedState.services.find((row) => row.name === name);
        return seedJsonResponse(200, { d: service ? [{ id: service.id }] : [] });
      }
      if (url.includes('/release_image')) {
        return seedJsonResponse(200, {
          d: seedState.releaseImages.map((link) => ({ image: { __id: link.image } })),
        });
      }
      if (url.includes('/release')) {
        if (url.includes('$select=raw_version') || url.includes('$select=is_final')) {
          return seedJsonResponse(200, { d: [] }); // field probes: supported
        }
        return seedJsonResponse(200, { d: seedState.releases });
      }
      if (url.includes('/image')) {
        if (url.includes('$select=is_stored_at__image_location')) {
          return seedJsonResponse(200, {
            d: [{ is_stored_at__image_location: `registry2.balena.example.com/v2/${ASSIGNED_REPO}` }],
          });
        }
        const hash = /content_hash%20eq%20'(sha256:[a-f0-9]+)'/.exec(url)?.[1];
        const image = seedState.images.find((row) => row.hash === hash);
        return seedJsonResponse(200, {
          d: image
            ? [
                {
                  id: image.id,
                  is_a_build_of__service: { __id: image.serviceId },
                  is_stored_at__image_location: `registry2.balena.example.com/v2/${ASSIGNED_REPO}`,
                  content_hash: image.hash,
                },
              ]
            : [],
        });
      }
    }

    // --- target registry (instance) ---
    if (url.includes('registry2.balena.example.com')) {
      if (method === 'HEAD') {
        const digest = /(?:blobs|manifests)\/(sha256:[a-f0-9]+)$/.exec(url)?.[1];
        return new Response(null, { status: presentAtTarget.has(digest ?? '') ? 200 : 404 });
      }
      if (method === 'POST' && url.endsWith('/blobs/uploads/')) {
        const uploadRepo = /\/v2\/(.+)\/blobs\/uploads\//.exec(url)?.[1] ?? ASSIGNED_REPO;
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

    // balenaCloud enrichment is deliberately unmocked: its failure must stay best-effort.
    return seedJsonResponse(500, { Error: { text: `unmocked ${method} ${url}` } });
  }) as typeof fetch;
};

const restoreFetch = (): void => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
};

beforeEach(() => {
  seedCalls.length = 0;
  presentAtTarget.clear();
  seedState.tagDigest = sha('d');
  seedState.application = null;
  seedState.services = [];
  seedState.releases = [];
  seedState.images = [];
  seedState.releaseImages = [];
  resetRegistryTokens();
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.balena.example.com';
  delete process.env.OPEN_BALENA_REGISTRY_URL;
  delete process.env.SUPERVISOR_SOURCE_REGISTRY;
});

test('a cold seed mirrors the tag-resolved digest into the hook-assigned repo', async () => {
  installSeedFetchMock();
  try {
    // `v`-prefixed version argument — normalized before the catalog lookup.
    const result = await seedSupervisorRelease({ authorization: 'Bearer caller' }, MACHINE, 'v19.0.8');

    assert.deepEqual(result, {
      appId: 99,
      releaseId: 42,
      images: [{ repo: ASSIGNED_REPO, digest: sha('d') }],
    });

    const instancePosts = seedCalls.filter(
      (call) => call.method === 'POST' && call.url.startsWith('https://api.balena.example.com/v6/'),
    );
    assert.deepEqual(
      instancePosts.map((call) => /\/v6\/([a-z_]+)/.exec(call.url)?.[1]),
      ['organization', 'application', 'service', 'image', 'release', 'release_image'],
    );

    // The image row is identified by the MIRROR digest resolved from the tag…
    const imagePost = instancePosts.find((call) => call.url.includes('/v6/image'));
    const imageBody = JSON.parse(String(imagePost?.body));
    assert.equal(imageBody.content_hash, sha('d'));
    assert.equal(imageBody.is_stored_at__image_location, 'registry2.balena.example.com/v2/aarch64-supervisor');
    assert.equal(imageBody.is_a_build_of__service, 55);

    // …the release keeps the raw tag and the parsed semver fields…
    const releasePost = instancePosts.find((call) => call.url.includes('/v6/release'));
    const releaseBody = JSON.parse(String(releasePost?.body));
    assert.equal(releaseBody.raw_version, 'v19.0.8');
    assert.equal(typeof releaseBody.start_timestamp, 'string');
    assert.equal(releaseBody.semver_major, 19);
    assert.equal(releaseBody.semver_minor, 0);
    assert.equal(releaseBody.semver_patch, 8);

    // …and the new image is linked into the release.
    const linkPost = instancePosts.find((call) => call.url.includes('/v6/release_image'));
    assert.deepEqual(JSON.parse(String(linkPost?.body)), { release: 42, image: 11 });

    // Every registry write went to the hook-ASSIGNED repo read back after create…
    const registryWrites = seedCalls.filter(
      (call) =>
        call.url.includes('registry2.balena.example.com/v2/') && (call.method === 'PUT' || call.method === 'POST'),
    );
    assert.ok(registryWrites.length > 0);
    for (const write of registryWrites) {
      assert.ok(write.url.includes(`/v2/${ASSIGNED_REPO}/`), `write hit the assigned repo: ${write.url}`);
    }
    // …and the mirrored manifest was verified there by digest.
    assert.ok(
      seedCalls.some(
        (call) =>
          call.method === 'HEAD' &&
          call.url === `https://registry2.balena.example.com/v2/${ASSIGNED_REPO}/manifests/${sha('d')}`,
      ),
      'digest is verified at the assigned target repo',
    );
  } finally {
    restoreFetch();
  }
});

test('a digest change re-seeds the new image and links it into the existing release', async () => {
  installSeedFetchMock();
  try {
    await seedSupervisorRelease({ authorization: 'Bearer caller' }, MACHINE, '19.0.8');

    // The mirror re-publishes the tag with different bytes.
    seedState.tagDigest = sha('f');

    const result = await seedSupervisorRelease({ authorization: 'Bearer caller' }, MACHINE, '19.0.8');

    assert.deepEqual(result, {
      appId: 99,
      releaseId: 42,
      images: [{ repo: ASSIGNED_REPO, digest: sha('f') }],
    });

    const instancePosts = seedCalls.filter(
      (call) => call.method === 'POST' && call.url.startsWith('https://api.balena.example.com/v6/'),
    );
    // Re-seed: no second app/service/release — image, then the release link.
    assert.deepEqual(
      instancePosts.map((call) => /\/v6\/([a-z_]+)/.exec(call.url)?.[1]),
      ['organization', 'application', 'service', 'image', 'release', 'release_image', 'image', 'release_image'],
    );

    // The new image row carries the NEW digest…
    const imagePosts = instancePosts.filter((call) => call.url.includes('/v6/image'));
    assert.equal(JSON.parse(String(imagePosts[1].body)).content_hash, sha('f'));
    // …and it is linked into the EXISTING release (id 42), not a new one.
    const linkPosts = instancePosts.filter((call) => call.url.includes('/v6/release_image'));
    assert.deepEqual(JSON.parse(String(linkPosts[1].body)), { release: 42, image: 12 });
    assert.deepEqual(seedState.releaseImages, [
      { release: 42, image: 11 },
      { release: 42, image: 12 },
    ]);

    // The new manifest was mirrored and verified at the target.
    assert.ok(
      seedCalls.some((call) => call.method === 'PUT' && call.url.endsWith(`/manifests/${sha('f')}`)),
      'new manifest bytes are mirrored',
    );
    assert.ok(
      seedCalls.some((call) => call.method === 'HEAD' && call.url.endsWith(`/manifests/${sha('f')}`)),
      'new digest is verified at the target',
    );
  } finally {
    restoreFetch();
  }
});

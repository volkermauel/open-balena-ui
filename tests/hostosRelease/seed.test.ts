import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planHostosSeedSteps, resolveHostosVersionsForDeviceType } from '../../server/controller/hostosRelease/seed';

const completeState = {
  appId: 99,
  serviceId: 55,
  imageId: 11,
  releaseId: 42,
  linkedImageIds: [11],
  hasVersionTag: true,
  bytesVerified: true,
  imageSize: 239695015,
};

test('a fully imported version plans no work', () => {
  assert.deepEqual(planHostosSeedSteps(completeState), ['complete']);
});

test('a cold import plans every step in link-before-mirror order', () => {
  assert.deepEqual(
    planHostosSeedSteps({
      linkedImageIds: [],
      hasVersionTag: false,
      bytesVerified: false,
    }),
    [
      'create-image-metadata',
      'create-release',
      'create-release-image',
      'mirror-bytes',
      'set-image-size',
      'create-release-tag',
    ],
  );
});

test('metadata existing but bytes unverified still mirrors after the release link', () => {
  assert.deepEqual(
    planHostosSeedSteps({
      ...completeState,
      releaseId: undefined,
      linkedImageIds: [],
      hasVersionTag: false,
      bytesVerified: false,
    }),
    // The existing image row already carries its size — only release, link, bytes and tag.
    ['create-release', 'create-release-image', 'mirror-bytes', 'create-release-tag'],
  );
});

test('a crashed import resumes: bytes there, release missing', () => {
  assert.deepEqual(
    planHostosSeedSteps({ ...completeState, releaseId: undefined, linkedImageIds: [], hasVersionTag: false }),
    ['create-release', 'create-release-image', 'create-release-tag'],
  );
});

test('release present but image unlinked finishes the link', () => {
  assert.deepEqual(planHostosSeedSteps({ ...completeState, linkedImageIds: [] }), ['create-release-image']);
});

test('release present without the version tag finishes the tag', () => {
  assert.deepEqual(planHostosSeedSteps({ ...completeState, hasVersionTag: false }), ['create-release-tag']);
});

test('an unsized but complete import records the image size', () => {
  assert.deepEqual(planHostosSeedSteps({ ...completeState, imageSize: null }), ['set-image-size']);
});

test('release present but bytes missing re-mirrors (registry wiped)', () => {
  assert.deepEqual(planHostosSeedSteps({ ...completeState, bytesVerified: false }), ['mirror-bytes']);
});

test('the versions listing only counts releases with their version tag as imported', async () => {
  const prevApi = process.env.REACT_APP_OPEN_BALENA_API_URL;
  const prevSrc = process.env.HOSTOS_SOURCE_REGISTRY;
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.openbalena.local';
  process.env.HOSTOS_SOURCE_REGISTRY = 'ghcr.example.com/owner';

  // A decodable JWT so the anonymous-token cache can read its expiry.
  const anonToken = [
    'e30',
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
    'x',
  ].join('.');

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('https://ghcr.example.com/token')) return json({ token: anonToken });
    if (url.includes('/tags/list')) return json({ tags: ['7.4.0-rev5', '7.4.0-rev6', 'nightly'] });
    if (url.includes('/v6/device_type'))
      return json({ d: [{ id: 120, slug: 'raspberrypi4-64', is_of__cpu_architecture: [{ slug: 'aarch64' }] }] });
    if (url.includes('/v6/application')) return json({ d: [{ id: 7 }] });
    if (url.includes('$select=raw_version&$top=1')) return json({ d: [] });
    if (url.includes('/v6/release?'))
      return json({
        d: [
          { id: 63, raw_version: '7.4.0-rev6', semver: '7.4.0+rev6' },
          { id: 64, raw_version: '7.4.0-rev5', semver: '7.4.0+rev5' },
        ],
      });
    if (url.includes('/v6/release_tag')) {
      // Release 64 carries its tag; release 63 is a crashed import (no tag).
      if (url.includes('release%20eq%2064')) return json({ d: [{ id: 2, value: '7.4.0+rev5' }] });
      return json({ d: [] });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const { versions } = await resolveHostosVersionsForDeviceType({ authorization: 'Bearer t' }, 'raspberrypi4-64');

    const rev6 = versions.find((entry) => entry.tag === '7.4.0-rev6')!;
    assert.equal(rev6.seeded, false, 'a release without its version tag stays importable');
    assert.equal(rev6.releaseId, 63);

    const rev5 = versions.find((entry) => entry.tag === '7.4.0-rev5')!;
    assert.equal(rev5.seeded, true);
    assert.equal(rev5.releaseId, 64);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevApi === undefined) delete process.env.REACT_APP_OPEN_BALENA_API_URL;
    else process.env.REACT_APP_OPEN_BALENA_API_URL = prevApi;
    if (prevSrc === undefined) delete process.env.HOSTOS_SOURCE_REGISTRY;
    else process.env.HOSTOS_SOURCE_REGISTRY = prevSrc;
  }
});

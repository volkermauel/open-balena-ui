import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_OS_IMAGE_SOURCE_REPO,
  MIRROR_CATALOG_CACHE_TTL_MS,
  MIRROR_FETCH_TIMEOUT_MS,
  clearMirrorCatalogCache,
  extractOsVersions,
  fetchMirrorReleases,
  findMirrorAsset,
  githubReleasesUrl,
  listOsVersions,
  nextReleasesUrlFromLink,
  osImageSourceRepo,
  parseSha256Sums,
  peekMirrorCatalogCache,
  toMirrorReleases,
  versionFromAssetName,
  type MirrorRelease,
} from '../../server/controller/osImage/versions';
import { OsImageError } from '../../server/controller/osImage/errors';

const originalFetch = globalThis.fetch;

const githubAsset = (
  name: string,
  url = `https://mirror.test/${name}`,
): { name: string; browser_download_url: string } => ({
  name,
  browser_download_url: url,
});

const githubRelease = (tagName: string, assets: Array<{ name: string; browser_download_url: string }>) => ({
  tag_name: tagName,
  assets,
});

/** Mock fetch serving canned responses per URL prefix; records every call. */
const mockFetch = (
  handler: (url: string) => { status: number; body?: unknown; contentType?: string; link?: string } | { throw: Error },
): { calls: string[]; restore: () => void } => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const result = handler(url);
    if ('throw' in result) {
      throw result.throw;
    }
    const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    return new Response(result.body === undefined ? null : body, {
      status: result.status,
      headers: {
        ...(result.contentType ? { 'Content-Type': result.contentType } : {}),
        ...(result.link ? { Link: result.link } : {}),
      },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
};

test.beforeEach(() => {
  clearMirrorCatalogCache();
  delete process.env.OS_IMAGE_SOURCE_REPO;
});

test.afterEach(() => {
  clearMirrorCatalogCache();
  delete process.env.OS_IMAGE_SOURCE_REPO;
  globalThis.fetch = originalFetch;
});

// --- pure asset-name matching -------------------------------------------------

test('versionFromAssetName matches assets for the exact device type slug', () => {
  assert.equal(versionFromAssetName('raspberrypi4-64', 'balenaos-7.4.0+rev5-raspberrypi4-64.img.zip'), '7.4.0+rev5');
  assert.equal(versionFromAssetName('raspberrypi5', 'balenaos-7.4.0+rev5-raspberrypi5.img.zip'), '7.4.0+rev5');
  assert.equal(versionFromAssetName('fincm3', 'balenaos-2.9.1-fincm3.img.zip'), '2.9.1');
});

test('versionFromAssetName rejects non-matching machines and shapes', () => {
  // Hyphenated slugs must not be mis-split onto a shorter machine suffix.
  assert.equal(versionFromAssetName('raspberrypi4-64', 'balenaos-7.4.0+rev5-raspberrypi4-640.img.zip'), null);
  assert.equal(versionFromAssetName('raspberrypi4-64', 'balenaos-7.4.0+rev5-raspberrypi5.img.zip'), null);
  assert.equal(versionFromAssetName('raspberrypi4-64', 'balenaos-7.4.0+rev5-raspberrypi4-64.img.gz'), null);
  assert.equal(versionFromAssetName('raspberrypi4-64', 'balenaos-7.4.0+rev5-raspberrypi4-64.img'), null);
  assert.equal(versionFromAssetName('raspberrypi4-64', 'SHA256SUMS'), null);
});

// --- pure release normalization / pagination ----------------------------------

test('toMirrorReleases keeps only well-formed releases and assets', () => {
  const releases = toMirrorReleases([
    githubRelease('v1', [githubAsset('a')]),
    { tag_name: 42, assets: [] },
    { assets: [githubAsset('b')] },
    'nope',
  ]);
  assert.deepEqual(releases, [{ tagName: 'v1', assets: [{ name: 'a', url: 'https://mirror.test/a' }] }]);
  assert.deepEqual(toMirrorReleases(null), []);
});

test('nextReleasesUrlFromLink extracts the rel=next target', () => {
  const link =
    '<https://api.github.com/repos/o/r/releases?per_page=100&page=2>; rel="next", ' +
    '<https://api.github.com/repos/o/r/releases?per_page=100&page=3>; rel="last"';
  assert.equal(nextReleasesUrlFromLink(link), 'https://api.github.com/repos/o/r/releases?per_page=100&page=2');
  assert.equal(nextReleasesUrlFromLink('<https://x>; rel="last"'), null);
  assert.equal(nextReleasesUrlFromLink(null), null);
});

test('nextReleasesUrlFromLink accepts unquoted and extended rel=next forms', () => {
  assert.equal(
    nextReleasesUrlFromLink(
      '<https://api.github.com/repos/o/r/releases?per_page=100&page=2>; rel="next"; title="page 2"',
    ),
    'https://api.github.com/repos/o/r/releases?per_page=100&page=2',
  );
  assert.equal(
    nextReleasesUrlFromLink('<https://api.github.com/repos/o/r/releases?per_page=100&page=2>; rel=next'),
    'https://api.github.com/repos/o/r/releases?per_page=100&page=2',
  );
  // Near-misses must not match: a longer rel token or rel in another param.
  assert.equal(nextReleasesUrlFromLink('<https://x>; rel="nextpage"'), null);
  assert.equal(nextReleasesUrlFromLink('<https://x>; title="next"; rel="last"'), null);
});

// --- pure version extraction ---------------------------------------------------

/** The mirror as the GitHub API serves it (raw JSON shape). */
const rawGithubReleases = [
  githubRelease('v7.4.0+rev5', [
    githubAsset('balenaos-7.4.0+rev5-raspberrypi4-64.img.zip'),
    githubAsset('balenaos-7.4.0+rev5-raspberrypi5.img.zip'),
    githubAsset('SHA256SUMS'),
  ]),
  githubRelease('v7.4.0+rev4', [githubAsset('balenaos-7.4.0+rev4-raspberrypi4-64.img.zip')]),
  githubRelease('v7.5.0', [githubAsset('balenaos-7.5.0-raspberrypi4-64.img.zip')]),
  githubRelease('v7.4.0+rev5-duplicate', [githubAsset('balenaos-7.4.0+rev5-raspberrypi4-64.img.zip')]),
  githubRelease('v2.9.1', [githubAsset('balenaos-2.9.1-raspberrypi5.img.zip')]),
];

const sampleReleases: MirrorRelease[] = toMirrorReleases(rawGithubReleases);

test('extractOsVersions deduplicates and orders semver-descending', () => {
  assert.deepEqual(extractOsVersions(sampleReleases, 'raspberrypi4-64'), ['7.5.0', '7.4.0+rev5', '7.4.0+rev4']);
  assert.deepEqual(extractOsVersions(sampleReleases, 'raspberrypi5'), ['7.4.0+rev5', '2.9.1']);
});

test('extractOsVersions returns an empty list for a device type the mirror does not serve', () => {
  assert.deepEqual(extractOsVersions(sampleReleases, 'fincm3'), []);
  assert.deepEqual(extractOsVersions([], 'raspberrypi4-64'), []);
});

// --- env configuration --------------------------------------------------------

test('osImageSourceRepo defaults and validates the <owner>/<repo> shape', () => {
  assert.equal(osImageSourceRepo(), DEFAULT_OS_IMAGE_SOURCE_REPO);

  process.env.OS_IMAGE_SOURCE_REPO = 'another-owner/mirror.repo-2';
  assert.equal(osImageSourceRepo(), 'another-owner/mirror.repo-2');

  // An empty value counts as unset (the default applies).
  for (const invalid of ['not-a-repo', 'a/b/c', 'owner/', '/repo', 'o wner/repo']) {
    process.env.OS_IMAGE_SOURCE_REPO = invalid;
    assert.throws(
      () => osImageSourceRepo(),
      (error: unknown) => {
        assert.ok(error instanceof OsImageError);
        assert.equal(error.statusCode, 500);
        assert.match(error.message, /OS_IMAGE_SOURCE_REPO/);
        return true;
      },
    );
  }
});

test('githubReleasesUrl builds the documented anonymous listing URL', () => {
  assert.equal(
    githubReleasesUrl('volkermauel/balena-raspberrypi-abrp'),
    'https://api.github.com/repos/volkermauel/balena-raspberrypi-abrp/releases?per_page=100',
  );
});

// --- listing against the (mocked) GitHub API -----------------------------------

test('listOsVersions serves mirror-sourced versions', async () => {
  const { calls, restore } = mockFetch(() => ({ status: 200, body: rawGithubReleases }));
  try {
    assert.deepEqual(await listOsVersions('raspberrypi4-64'), ['7.5.0', '7.4.0+rev5', '7.4.0+rev4']);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\?per_page=100$/);
  } finally {
    restore();
  }
});

test('fetchMirrorReleases follows Link-header pagination', async () => {
  const { calls, restore } = mockFetch((url) => {
    if (url.endsWith('page=2')) {
      return { status: 200, body: [githubRelease('v3.0.0', [githubAsset('balenaos-3.0.0-raspberrypi5.img.zip')])] };
    }
    return {
      status: 200,
      body: rawGithubReleases,
      link: '<https://api.github.com/repos/o/r/releases?per_page=100&page=2>; rel="next"',
    };
  });

  try {
    const releases = await fetchMirrorReleases();
    assert.equal(calls.length, 2);
    assert.ok(releases.some((release) => release.tagName === 'v3.0.0'));
    assert.ok(releases.some((release) => release.tagName === 'v7.5.0'));
  } finally {
    restore();
  }
});

test('fetchMirrorReleases maps upstream errors to a typed 502 naming api.github.com', async () => {
  const { restore } = mockFetch(() => ({ status: 500 }));
  try {
    await assert.rejects(fetchMirrorReleases(), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /api\.github\.com/);
      return true;
    });
  } finally {
    restore();
  }
});

test('fetchMirrorReleases maps network failures to a typed 502', async () => {
  const { restore } = mockFetch(() => ({ throw: new Error('ECONNREFUSED') }));
  try {
    await assert.rejects(fetchMirrorReleases(), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    });
  } finally {
    restore();
  }
});

test('the releases listing is cached in-process for 5 minutes', async () => {
  const { calls, restore } = mockFetch(() => ({ status: 200, body: rawGithubReleases }));
  try {
    await fetchMirrorReleases();
    await fetchMirrorReleases();
    await fetchMirrorReleases();
    assert.equal(calls.length, 1, 'cached listing must not re-fetch');

    const cached = peekMirrorCatalogCache();
    assert.ok(cached);
    cached.fetchedAt = Date.now() - MIRROR_CATALOG_CACHE_TTL_MS - 1;
    await fetchMirrorReleases();
    assert.equal(calls.length, 2, 'an expired listing must re-fetch');

    assert.equal(MIRROR_CATALOG_CACHE_TTL_MS, 5 * 60 * 1000);
  } finally {
    restore();
  }
});

// --- SHA256SUMS parsing and asset resolution -----------------------------------

test('parseSha256Sums parses standard checksum lines', () => {
  const sums = parseSha256Sums(
    `${'a'.repeat(64)}  balenaos-7.4.0+rev5-raspberrypi4-64.img.zip\n` +
      `${'b'.repeat(64)} *binary-marker.img.zip\r\n` +
      'not-a-checksum-line\n',
  );
  assert.equal(sums.get('balenaos-7.4.0+rev5-raspberrypi4-64.img.zip'), 'a'.repeat(64));
  assert.equal(sums.get('binary-marker.img.zip'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
  assert.deepEqual([...parseSha256Sums('').keys()], []);
});

test('findMirrorAsset resolves the asset URL and its SHA256SUMS entry', async () => {
  const { calls, restore } = mockFetch((url) => {
    if (url === 'https://mirror.test/SHA256SUMS') {
      return {
        status: 200,
        body: `${'a'.repeat(64)}  balenaos-7.4.0+rev5-raspberrypi4-64.img.zip\n`,
        contentType: 'text/plain',
      };
    }
    return { status: 200, body: rawGithubReleases };
  });

  try {
    const asset = await findMirrorAsset('raspberrypi4-64', '7.4.0+rev5');
    assert.deepEqual(asset, {
      name: 'balenaos-7.4.0+rev5-raspberrypi4-64.img.zip',
      url: 'https://mirror.test/balenaos-7.4.0+rev5-raspberrypi4-64.img.zip',
      sha256: 'a'.repeat(64),
    });
    assert.equal(calls.length, 2, 'listing + sums fetch');
  } finally {
    restore();
  }
});

test('findMirrorAsset returns sha256 undefined when the release has no SHA256SUMS entry', async () => {
  const { restore } = mockFetch(() => ({
    status: 200,
    body: [githubRelease('v7.4.0+rev4', [githubAsset('balenaos-7.4.0+rev4-raspberrypi4-64.img.zip')])],
  }));
  try {
    const asset = await findMirrorAsset('raspberrypi4-64', '7.4.0+rev4');
    assert.equal(asset.sha256, undefined);
    assert.equal(asset.url, 'https://mirror.test/balenaos-7.4.0+rev4-raspberrypi4-64.img.zip');
  } finally {
    restore();
  }
});

test('findMirrorAsset fails with a typed 404 naming device type, version and mirror', async () => {
  const { restore } = mockFetch(() => ({ status: 200, body: rawGithubReleases }));
  try {
    await assert.rejects(findMirrorAsset('fincm3', '1.0.0'), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 404);
      assert.match(error.message, /fincm3/);
      assert.match(error.message, /1\.0\.0/);
      assert.ok(error.message.includes(DEFAULT_OS_IMAGE_SOURCE_REPO));
      return true;
    });
  } finally {
    restore();
  }
});

test('concurrent cold misses share one in-flight pagination run', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    // Hold the only page back so both callers join while the run is in flight.
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Response(JSON.stringify(rawGithubReleases), { status: 200 });
  }) as typeof fetch;

  try {
    const [first, second] = await Promise.all([fetchMirrorReleases(), fetchMirrorReleases()]);
    assert.equal(calls.length, 1, 'both cold misses must share one pagination run');
    assert.deepEqual(first, second);
    assert.ok(first.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a rejected pagination run evicts itself instead of poisoning the cache', async () => {
  let failing = true;
  const { calls, restore } = mockFetch(() =>
    failing ? { throw: new Error('ECONNREFUSED') } : { status: 200, body: rawGithubReleases },
  );
  try {
    await assert.rejects(fetchMirrorReleases(), /Failed to reach api\.github\.com/);
    const callsAfterFailure = calls.length;

    failing = false;
    const releases = await fetchMirrorReleases();
    assert.ok(releases.length > 0, 'a later caller must get a fresh run, not the cached rejection');
    assert.equal(calls.length, callsAfterFailure + 1);
  } finally {
    restore();
  }
});

test('a timed-out catalog fetch surfaces as a typed 502 naming the timeout', async () => {
  const { restore } = mockFetch(() => ({
    throw: new DOMException('signal timed out', 'TimeoutError'),
  }));
  assert.equal(MIRROR_FETCH_TIMEOUT_MS, 30 * 1000);
  try {
    await assert.rejects(fetchMirrorReleases(), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /signal timed out/);
      return true;
    });
  } finally {
    restore();
  }
});

test('catalog and SHA256SUMS fetches carry an abort-timeout signal', async () => {
  const signals: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    signals.push(init?.signal);
    if (url.endsWith('/SHA256SUMS')) {
      return new Response('', { status: 200 });
    }
    return new Response(JSON.stringify(rawGithubReleases), { status: 200 });
  }) as typeof fetch;

  try {
    await findMirrorAsset('raspberrypi4-64', '7.4.0+rev5');
    assert.equal(signals.length, 2, 'listing + sums fetch');
    for (const signal of signals) {
      assert.ok(signal instanceof AbortSignal, 'every mirror fetch must be timeout-bounded');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pagination merges two pages duplicate-free and a missing Link header terminates', async () => {
  const page2 = [
    githubRelease('v3.0.0', [githubAsset('balenaos-3.0.0-raspberrypi4-64.img.zip')]),
    // Same balenaOS version as page 1 under another tag: versions must still dedupe.
    githubRelease('v7.4.0+rev5-again', [githubAsset('balenaos-7.4.0+rev5-raspberrypi4-64.img.zip')]),
  ];
  const { calls, restore } = mockFetch((url) => {
    if (url.endsWith('page=2')) {
      return { status: 200, body: page2 };
    }
    return {
      status: 200,
      body: rawGithubReleases,
      link: '<https://api.github.com/repos/o/r/releases?per_page=100&page=2>; rel="next"',
    };
  });

  try {
    const releases = await fetchMirrorReleases();
    assert.equal(calls.length, 2);
    assert.equal(releases.length, rawGithubReleases.length + page2.length, 'both pages merge exactly once');
    const tagNames = releases.map((release) => release.tagName);
    assert.equal(new Set(tagNames).size, tagNames.length, 'merged release tags must be duplicate-free');
    // The cached merge dedupes the version served by two tags into one dropdown entry.
    assert.deepEqual(await listOsVersions('raspberrypi4-64'), ['7.5.0', '7.4.0+rev5', '7.4.0+rev4', '3.0.0']);
  } finally {
    restore();
  }

  // A response without a Link header terminates after a single fetch carrying all entries.
  clearMirrorCatalogCache();
  const terminal = mockFetch(() => ({ status: 200, body: rawGithubReleases }));
  try {
    const releases = await fetchMirrorReleases();
    assert.equal(terminal.calls.length, 1, 'no Link header means no further pages');
    assert.equal(releases.length, rawGithubReleases.length, 'all entries from the single page');
  } finally {
    terminal.restore();
  }
});

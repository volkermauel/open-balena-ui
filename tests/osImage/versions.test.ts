import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractOsVersions,
  listOsVersions,
  osVersionsUrl,
  releaseListFilter,
} from '../../server/controller/osImage/versions';
import { OsImageError } from '../../server/controller/osImage/errors';

const fakeFetch = (handler: (url: string) => { status: number; body?: unknown; throw?: Error }) => {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const result = handler(url);
    if (result.throw) {
      throw result.throw;
    }
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
};

test('extractOsVersions deduplicates raw_version values', () => {
  const payload = { d: [{ raw_version: '3.2.7' }, { raw_version: '3.2.7' }, { raw_version: '3.2.6' }] };
  assert.deepEqual(extractOsVersions(payload), ['3.2.7', '3.2.6']);
});

test('extractOsVersions orders semver-descending regardless of input order', () => {
  const payload = [
    { raw_version: '2.9.1' },
    { raw_version: '3.2.7' },
    { raw_version: '10.0.0' },
    { raw_version: '3.2.7+rev1' },
    { raw_version: 'v3.2.8' },
    { raw_version: '3.2.7' },
  ];
  assert.deepEqual(extractOsVersions(payload), ['10.0.0', 'v3.2.8', '3.2.7', '3.2.7+rev1', '2.9.1']);
});

test('extractOsVersions skips entries without a raw_version string', () => {
  const payload = {
    d: [{ raw_version: '3.2.7' }, { raw_version: 42 }, {}, { raw_version: '' }, { raw_version: '3.1.0' }],
  };
  assert.deepEqual(extractOsVersions(payload), ['3.2.7', '3.1.0']);
});

test('extractOsVersions tolerates unexpected payload shapes', () => {
  assert.deepEqual(extractOsVersions(null), []);
  assert.deepEqual(extractOsVersions({}), []);
  assert.deepEqual(extractOsVersions({ d: 'nope' }), []);
});

test('releaseListFilter embeds the device type slug', () => {
  const filter = releaseListFilter('raspberrypi4-64');
  assert.match(filter, /is_final eq true/);
  assert.match(filter, /semver_major gt 0/);
  assert.match(filter, /dt\/slug eq 'raspberrypi4-64'/);
});

test('osVersionsUrl builds the documented release query', () => {
  const url = new URL(osVersionsUrl('raspberrypi4-64'));
  assert.equal(url.pathname, '/v7/release');
  assert.equal(url.searchParams.get('$select'), 'raw_version');
  assert.match(url.searchParams.get('$filter') ?? '', /belongs_to__application\/any\(bta:/);
  assert.equal(url.searchParams.get('$orderby'), 'semver_major desc,semver_minor desc,semver_patch desc,revision desc');
});

test('listOsVersions returns deduplicated versions on success', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = fakeFetch((url) => {
    requestedUrl = url;
    return { status: 200, body: { d: [{ raw_version: '3.2.7' }, { raw_version: '3.2.6' }, { raw_version: '3.2.7' }] } };
  });

  try {
    const versions = await listOsVersions('raspberrypi4-64');
    assert.deepEqual(versions, ['3.2.7', '3.2.6']);
    assert.match(requestedUrl, /\/v7\/release\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listOsVersions maps upstream errors to a typed 502 error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => ({ status: 500 }));

  try {
    await assert.rejects(listOsVersions('raspberrypi4-64'), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /raspberrypi4-64/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listOsVersions maps network failures to a typed 502 error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => ({ status: 0, throw: new Error('ECONNREFUSED') }));

  try {
    await assert.rejects(listOsVersions('raspberrypi4-64'), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

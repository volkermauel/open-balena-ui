import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError } from '../../server/controller/supervisorRelease/errors';
import { updateSupervisorReleases } from '../../server/controller/supervisorRelease/update';

/**
 * The device update flow only PINS already-imported supervisor versions —
 * importing (mirroring into the per-arch registry repo) happens exclusively on
 * the arch-scoped Supervisor Versions surface. No request may leave the
 * instance API (no mirror/token round-trips).
 */
interface CapturedRequest {
  url: string;
  method: string;
}

const withMockedApi = async (work: () => Promise<unknown>): Promise<CapturedRequest[]> => {
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    captured.push({ url, method: init?.method ?? 'GET' });
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

    if (url.includes('/v6/device_type')) {
      return json({ d: [{ id: 120, slug: 'raspberrypi4-64', is_of__cpu_architecture: [{ slug: 'aarch64' }] }] });
    }
    if (url.includes('/v6/application')) {
      return json(process.env.MOCK_APP_EXISTS === '1' ? { d: [{ id: 99 }] } : { d: [] });
    }
    if (url.includes('$select=raw_version&$top=1')) {
      return json({ d: [] });
    }
    if (url.includes('/v6/release?')) {
      return json({ d: [{ id: 42, raw_version: 'v19.0.8', semver: '19.0.8' }] });
    }
    if (url.includes('/v7/device(7)')) {
      return json({ d: [{ id: 7 }] });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const previousUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.openbalena.local';
  try {
    await work();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) {
      delete process.env.REACT_APP_OPEN_BALENA_API_URL;
    } else {
      process.env.REACT_APP_OPEN_BALENA_API_URL = previousUrl;
    }
  }
  return captured;
};

test('update refuses a version that is not imported (no mirroring from the device flow)', async () => {
  delete process.env.MOCK_APP_EXISTS;
  await assert.rejects(
    withMockedApi(() => updateSupervisorReleases({ authorization: 'Bearer t' }, 'raspberrypi4-64', '19.0.9', [7])),
    (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.match(error.message, /not imported for architecture aarch64/);
      assert.match(error.message, /Supervisor Versions/);
      return true;
    },
  );
});

test('update pins an imported version without any mirror round-trip', async () => {
  process.env.MOCK_APP_EXISTS = '1';
  try {
    const captured = await withMockedApi(() =>
      updateSupervisorReleases({ authorization: 'Bearer t' }, 'raspberrypi4-64', '19.0.8', [7]).then((outcome) => {
        assert.equal(outcome.releaseId, 42);
        assert.deepEqual(outcome.results, [{ id: 7, ok: true }]);
      }),
    );

    // Everything stayed on the instance API — no ghcr/token/mirror request.
    assert.ok(
      captured.every((call) => call.url.startsWith('https://api.openbalena.local')),
      `non-instance request seen: ${captured.map((call) => call.url).join(', ')}`,
    );
    const patch = captured.find((call) => call.method === 'PATCH' && call.url.includes('/v7/device(7)'));
    assert.ok(patch, 'device PATCH hit /v7/device');
    const queriedSlug = captured.some((call) => call.url.includes('balena_os/aarch64-supervisor'));
    assert.ok(queriedSlug, 'the per-arch supervisor application was looked up');
  } finally {
    delete process.env.MOCK_APP_EXISTS;
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createImage,
  getDeviceSupervisorState,
  listDeviceTypeArches,
  patchDeviceSupervisorRelease,
} from '../../server/controller/supervisorRelease/instance';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * `createImage` is shared by the supervisor and hostOS seeding flows, so this
 * payload assertion covers both: open-balena-api rejects image rows whose
 * status is 'success' but that carry no push_timestamp.
 */
test('createImage posts status success with both start and push timestamps', async () => {
  const previousUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.openbalena.local';

  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify({ id: 77 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const created = await createImage(
      { authorization: 'Bearer token' },
      12,
      'registry2.openbalena.local/v2/balenaos-hostapp/raspberrypi5',
      `sha256:${'a'.repeat(64)}`,
    );

    assert.deepEqual(created, { id: 77 });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, 'https://api.openbalena.local/v6/image');

    const body = captured[0].body;
    assert.equal(body.status, 'success');
    assert.equal(typeof body.start_timestamp, 'string');
    assert.equal(typeof body.push_timestamp, 'string');
    assert.match(String(body.start_timestamp), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(String(body.push_timestamp), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) {
      delete process.env.REACT_APP_OPEN_BALENA_API_URL;
    } else {
      process.env.REACT_APP_OPEN_BALENA_API_URL = previousUrl;
    }
  }
});

/**
 * `should be managed by release` only exists in the instance API's v7
 * translation — a /v6/device query containing it fails with 500 "Could not
 * resolve relationship mapping", so both the state read and the target PATCH
 * must go to /v7.
 */
test('device supervisor state read and target patch use the v7 device endpoint', async () => {
  const previousUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.openbalena.local';

  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (url.includes('$select=raw_version&$top=1')) {
      return new Response(JSON.stringify({ d: [] }), { status: 200 });
    }
    if (url.includes('/v7/device(3)') && (init?.method ?? 'GET') === 'GET') {
      return new Response(
        JSON.stringify({
          d: [
            {
              supervisor_version: '19.0.6',
              should_be_managed_by__release: [{ id: 42, raw_version: 'v19.0.8', semver: '19.0.8' }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ d: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const state = await getDeviceSupervisorState({ authorization: 'Bearer t' }, 3);
    assert.equal(state.current, '19.0.6');
    assert.equal(state.targetReleaseId, 42);
    assert.equal(state.targetSemver, '19.0.8');

    await patchDeviceSupervisorRelease({ authorization: 'Bearer t' }, 3, 42);

    assert.ok(
      captured.every(
        (call) => !call.url.includes('/v6/device('),
        'no device query may hit v6 (no managed-by mapping there)',
      ),
    );
    const get = captured.find((call) => call.url.includes('/v7/device(3)?'));
    assert.ok(get, 'state read hit /v7/device');
    const patch = captured.find((call) => call.url.includes('/v7/device(3)') && !call.url.includes('?'));
    assert.ok(patch, 'target patch hit /v7/device');
    assert.equal(patch.body.should_be_managed_by__release, 42);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) {
      delete process.env.REACT_APP_OPEN_BALENA_API_URL;
    } else {
      process.env.REACT_APP_OPEN_BALENA_API_URL = previousUrl;
    }
  }
});

/**
 * The arch picker of the arch-scoped supervisor import dialog lists the
 * distinct CPU architectures across the instance's device types.
 */
test('listDeviceTypeArches returns distinct sorted arch slugs', async () => {
  const previousUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.openbalena.local';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        d: [
          { id: 120, is_of__cpu_architecture: [{ slug: 'aarch64' }] },
          { id: 123, is_of__cpu_architecture: [{ slug: 'aarch64' }] },
          { id: 44, is_of__cpu_architecture: [{ slug: 'amd64' }] },
          { id: 45, is_of__cpu_architecture: null },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

  try {
    const arches = await listDeviceTypeArches({ authorization: 'Bearer t' });
    assert.deepEqual(arches, ['aarch64', 'amd64']);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) {
      delete process.env.REACT_APP_OPEN_BALENA_API_URL;
    } else {
      process.env.REACT_APP_OPEN_BALENA_API_URL = previousUrl;
    }
  }
});

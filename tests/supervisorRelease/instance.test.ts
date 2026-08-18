import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImage } from '../../server/controller/supervisorRelease/instance';

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

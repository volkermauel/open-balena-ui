import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyGatewaySshKeys,
  buildDownloadConfigBody,
  generateFleetConfig,
  parseGatewaySshPublicKeys,
} from '../../server/controller/osImage/config';
import { OsImageError } from '../../server/controller/osImage/errors';
import type { FleetConfigOptions } from '../../server/controller/osImage/cacheStore';

const baseOptions: FleetConfigOptions = {
  appId: 42,
  version: '3.2.7',
  network: 'ethernet',
};

test('buildDownloadConfigBody omits undefined optional fields', () => {
  assert.deepEqual(buildDownloadConfigBody(baseOptions), {
    appId: 42,
    version: '3.2.7',
    network: 'ethernet',
  });

  // The device type is passed through so mixed fleets can differ from the fleet's own type.
  assert.deepEqual(buildDownloadConfigBody({ ...baseOptions, deviceType: 'raspberrypi5' }), {
    appId: 42,
    version: '3.2.7',
    deviceType: 'raspberrypi5',
    network: 'ethernet',
  });

  assert.deepEqual(
    buildDownloadConfigBody({
      ...baseOptions,
      network: 'wifi',
      appUpdatePollInterval: 10,
      developmentMode: true,
      wifiSsid: 'home-network',
      wifiKey: 'secret',
    }),
    {
      appId: 42,
      version: '3.2.7',
      network: 'wifi',
      appUpdatePollInterval: 10,
      developmentMode: true,
      wifiSsid: 'home-network',
      wifiKey: 'secret',
    },
  );
});

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

const captureFetch = (
  handler: (url: string, init: RequestInit) => { status: number; body?: unknown; throw?: Error },
) => {
  const captured: CapturedRequest[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const request = { url, init: init ?? {} };
    captured.push(request);
    const result = handler(url, request.init);
    if (result.throw) {
      throw result.throw;
    }
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return { captured, fake };
};

test('generateFleetConfig forwards the caller JWT to openBalena /download-config', async () => {
  const previousUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.openbalena.local/';

  const { captured, fake } = captureFetch(() => ({
    status: 200,
    body: { applicationId: 42, apiKey: 'cfg' },
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake;

  try {
    const config = await generateFleetConfig('Bearer caller-jwt', {
      ...baseOptions,
      network: 'wifi',
      developmentMode: true,
      wifiSsid: 'net',
    });

    assert.deepEqual(config, { applicationId: 42, apiKey: 'cfg' });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, 'https://api.openbalena.local/download-config');
    assert.equal(captured[0].init.method, 'POST');
    assert.equal((captured[0].init.headers as Record<string, string>).Authorization, 'Bearer caller-jwt');
    assert.deepEqual(JSON.parse(captured[0].init.body as string) as Record<string, unknown>, {
      appId: 42,
      version: '3.2.7',
      network: 'wifi',
      developmentMode: true,
      wifiSsid: 'net',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) {
      delete process.env.REACT_APP_OPEN_BALENA_API_URL;
    } else {
      process.env.REACT_APP_OPEN_BALENA_API_URL = previousUrl;
    }
  }
});

test('generateFleetConfig maps 401/403 to a typed 401 error', async () => {
  const previousUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.openbalena.local';

  for (const status of [401, 403]) {
    const { fake } = captureFetch(() => ({ status }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fake;
    try {
      await assert.rejects(generateFleetConfig('Bearer expired', baseOptions), (error: unknown) => {
        assert.ok(error instanceof OsImageError);
        assert.equal(error.statusCode, 401);
        assert.match(error.message, /session may have expired/);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  delete process.env.REACT_APP_OPEN_BALENA_API_URL;
  if (previousUrl !== undefined) {
    process.env.REACT_APP_OPEN_BALENA_API_URL = previousUrl;
  }
});

test('generateFleetConfig maps other upstream failures and network errors to 502', async () => {
  const previousUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.openbalena.local';

  const failing = captureFetch(() => ({ status: 400, body: { error: 'bad request' } }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = failing.fake;
  try {
    await assert.rejects(generateFleetConfig('Bearer token', baseOptions), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 502);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const throwing = captureFetch(() => ({ status: 0, throw: new Error('ECONNREFUSED') }));
  globalThis.fetch = throwing.fake;
  try {
    await assert.rejects(generateFleetConfig('Bearer token', baseOptions), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  delete process.env.REACT_APP_OPEN_BALENA_API_URL;
  if (previousUrl !== undefined) {
    process.env.REACT_APP_OPEN_BALENA_API_URL = previousUrl;
  }
});

test('generateFleetConfig requires an authorization header and configured API url', async () => {
  await assert.rejects(generateFleetConfig(undefined, baseOptions), (error: unknown) => {
    assert.ok(error instanceof OsImageError);
    assert.equal(error.statusCode, 401);
    return true;
  });

  const previousUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  delete process.env.REACT_APP_OPEN_BALENA_API_URL;
  try {
    await assert.rejects(generateFleetConfig('Bearer token', baseOptions), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 500);
      return true;
    });
  } finally {
    if (previousUrl !== undefined) {
      process.env.REACT_APP_OPEN_BALENA_API_URL = previousUrl;
    }
  }
});

// --- gateway SSH keys (GATEWAY_SSH_PUBLIC_KEYS) ---------------------------------

test('parseGatewaySshPublicKeys splits on newlines, trims and drops empty lines', () => {
  assert.deepEqual(
    parseGatewaySshPublicKeys(
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI comment\r\n\n \nssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ==',
    ),
    ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI comment', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ=='],
  );
  assert.deepEqual(parseGatewaySshPublicKeys(undefined), []);
  assert.deepEqual(parseGatewaySshPublicKeys(''), []);
  assert.deepEqual(parseGatewaySshPublicKeys(' \n\t\n'), []);
  // The ecdsa family's real openssh prefix is accepted too.
  assert.deepEqual(parseGatewaySshPublicKeys('ecdsa-sha2-nistp256 AAAAE2VjZHNh comment'), [
    'ecdsa-sha2-nistp256 AAAAE2VjZHNh comment',
  ]);
});

test('parseGatewaySshPublicKeys accepts hardware (sk-) and certificate (-cert-v01) key forms', () => {
  const keys =
    'sk-ssh-ed25519@openssh.com AAAAC3NzaC1lZDI1NTE5AAAAI yubikey\n' +
    'sk-ecdsa-sha2-nistp256@openssh.com AAAAE2VjZHNh ecdsa-token\n' +
    'ssh-ed25519-cert-v01@openssh.com AAAAC3NzaC1lZDI1NTE5 ed25519-cert\n' +
    'ecdsa-sha2-nistp384-cert-v01@openssh.com AAAAE2VjZHNh nistp384-cert\n' +
    'sk-ssh-ed25519-cert-v01@openssh.com AAAAC3NzaC1lZDI1NTE5 sk-cert';
  assert.deepEqual(parseGatewaySshPublicKeys(keys), keys.split('\n'));
});

test('parseGatewaySshPublicKeys rejects malformed keys with a config error naming the env var', () => {
  for (const invalid of [
    'not-a-key',
    'ssh-ed25519',
    'ssh-ed25519-with-typo AAAAC3Nza',
    'ssh-rsa !!!not-base64!!!',
    'AAAAC3NzaC1lZDI1NTE5 (missing the type prefix)',
    'sk-rsa AAAAC3NzaC1lZDI1NTE5 (sk- must precede a real family)',
  ]) {
    assert.throws(
      () => parseGatewaySshPublicKeys(invalid),
      (error: unknown) => {
        assert.ok(error instanceof OsImageError);
        assert.equal(error.statusCode, 500);
        assert.match(error.message, /GATEWAY_SSH_PUBLIC_KEYS/);
        return true;
      },
    );
  }
});

test('applyGatewaySshKeys merges keys into os.sshKeys and leaves unconfigured configs untouched', () => {
  const untouched = { applicationId: 42, apiKey: 'cfg' };
  assert.equal(applyGatewaySshKeys(untouched, []), untouched);

  const gatewayKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI gateway';
  assert.deepEqual(applyGatewaySshKeys({ applicationId: 42 }, [gatewayKey]), {
    applicationId: 42,
    os: { sshKeys: [gatewayKey] },
  });

  // Existing keys are kept (unique append), other os fields preserved.
  assert.deepEqual(
    applyGatewaySshKeys({ os: { sshKeys: ['existing'], version: '2.144.0' } }, [gatewayKey, 'existing']),
    { os: { sshKeys: ['existing', gatewayKey], version: '2.144.0' } },
  );
});

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  artifactDownloadFilename,
  createOsImageJob,
  downloadPristineMirrorImage,
  getOsImageJob,
  MIRROR_ASSET_DOWNLOAD_TIMEOUT_MS,
  toFleetConfigOptions,
  type OsImageJob,
  type OsImageJobEntry,
  type PrepareOsImageRequest,
} from '../../server/controller/osImage/prepareJob';
import { clearMirrorCatalogCache } from '../../server/controller/osImage/versions';
import { configSha16, isValidDeviceTypeSlug, isValidOsVersion } from '../../server/controller/osImage/cacheStore';
import { CacheStore } from '../../server/controller/osImage/cacheStore';
import { makeZip } from './helpers';
import { OsImageError } from '../../server/controller/osImage/errors';

const baseRequest: PrepareOsImageRequest = {
  deviceType: 'raspberrypi4-64',
  version: '3.2.7',
  variant: 'production',
  format: 'zip',
  appId: 42,
  fleetName: 'My Fleet',
  network: 'ethernet',
};

test('artifactDownloadFilename sanitizes the fleet name', () => {
  assert.equal(artifactDownloadFilename(baseRequest), 'raspberrypi4-64-3.2.7-My-Fleet.zip');
  assert.equal(
    artifactDownloadFilename({ ...baseRequest, format: 'gz', fleetName: 'prod / fleet #1' }),
    'raspberrypi4-64-3.2.7-prod-fleet-1.gz',
  );
  assert.equal(artifactDownloadFilename({ ...baseRequest, fleetName: '///' }), 'raspberrypi4-64-3.2.7-fleet.zip');
});

test('artifactDownloadFilename sanitizes hostile device types and versions', () => {
  assert.equal(
    artifactDownloadFilename({ ...baseRequest, deviceType: '../../etc', version: '1.0.0"\r\nX-Evil: x' }),
    '..-..-etc-1.0.0-X-Evil-x-My-Fleet.zip',
  );
});

test('device type slugs are strictly allow-listed', () => {
  assert.equal(isValidDeviceTypeSlug('raspberrypi4-64'), true);
  assert.equal(isValidDeviceTypeSlug('generic-amd64'), true);
  assert.equal(isValidDeviceTypeSlug('fincm3'), true);
  assert.equal(isValidDeviceTypeSlug('../img'), false);
  assert.equal(isValidDeviceTypeSlug('a/b'), false);
  assert.equal(isValidDeviceTypeSlug('.hidden'), false);
  assert.equal(isValidDeviceTypeSlug(''), false);
  assert.equal(isValidDeviceTypeSlug('x'.repeat(65)), false);
});

test('OS versions are strictly allow-listed', () => {
  assert.equal(isValidOsVersion('3.2.7'), true);
  assert.equal(isValidOsVersion('7.4.0+rev5'), true);
  assert.equal(isValidOsVersion('2026.7.0'), true);
  assert.equal(isValidOsVersion('latest'), true);
  assert.equal(isValidOsVersion('../../out/x'), false);
  assert.equal(isValidOsVersion('1.0.0 evil'), false);
  assert.equal(isValidOsVersion(''), false);
});

test('toFleetConfigOptions maps optional fields but never a development mode', () => {
  assert.deepEqual(toFleetConfigOptions(baseRequest), {
    appId: 42,
    version: '3.2.7',
    network: 'ethernet',
  });

  assert.deepEqual(
    toFleetConfigOptions({
      ...baseRequest,
      network: 'wifi',
      appUpdatePollInterval: 10,
      wifiSsid: 'net',
      wifiKey: 'secret',
    }),
    {
      appId: 42,
      version: '3.2.7',
      network: 'wifi',
      appUpdatePollInterval: 10,
      wifiSsid: 'net',
      wifiKey: 'secret',
    },
  );

  // The production-only mirror dropped the development variant entirely.
  assert.deepEqual(toFleetConfigOptions({ ...baseRequest, variant: 'development' }), {
    appId: 42,
    version: '3.2.7',
    network: 'ethernet',
  });
});

test('job request fields fully determine the artifact cache key', () => {
  const production = toFleetConfigOptions(baseRequest);
  const sameOptionsDifferentVariant = toFleetConfigOptions({ ...baseRequest, variant: 'development' });

  assert.equal(configSha16(production, 'zip'), configSha16(sameOptionsDifferentVariant, 'zip'));
  assert.notEqual(configSha16(production, 'zip'), configSha16(production, 'gz'));
  assert.equal(configSha16(production, 'zip'), configSha16(toFleetConfigOptions(baseRequest), 'zip'));
});

// --- pristine mirror downloads (sha256 verification) -----------------------------

const MIRROR_ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x05, 0x06, 0x00, 0x01, 0x02, 0x03]);
const MIRROR_ZIP_SHA256 = createHash('sha256').update(MIRROR_ZIP_BYTES).digest('hex');
const ASSET_NAME = 'balenaos-3.2.7-raspberrypi4-64.img.zip';

const githubListing = (assets: string[]): unknown => [
  {
    tag_name: 'v3.2.7',
    assets: assets.map((name) => ({ name, browser_download_url: `https://mirror.test/${name}` })),
  },
];

const mockMirrorFetch = (
  listing: unknown,
  sumsBody: string | undefined,
  assetBytes: Buffer,
): { calls: string[]; restore: () => void } => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify(listing), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/SHA256SUMS')) {
      return new Response(sumsBody ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response(assetBytes, { status: 200, headers: { 'Content-Length': String(assetBytes.length) } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
};

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'obui-os-image-prepare-'));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
};

const makeJob = (): OsImageJobEntry => ({ jobId: 'test-job', phase: 'downloading', request: { ...baseRequest } });

test.beforeEach(() => clearMirrorCatalogCache());
test.afterEach(() => clearMirrorCatalogCache());

test('downloadPristineMirrorImage streams the asset and commits it when the sha256 matches', async () => {
  const { restore } = mockMirrorFetch(
    githubListing([ASSET_NAME, 'SHA256SUMS']),
    `${MIRROR_ZIP_SHA256}  ${ASSET_NAME}\n`,
    MIRROR_ZIP_BYTES,
  );

  await withTempDir(async (dir) => {
    const destination = path.join(dir, 'pristine.zip');
    const job = makeJob();
    try {
      await downloadPristineMirrorImage(job, destination);

      assert.ok((await fsp.readFile(destination)).equals(MIRROR_ZIP_BYTES));
      assert.equal(job.progress?.downloadedBytes, MIRROR_ZIP_BYTES.length);
      assert.deepEqual(await fsp.readdir(dir), ['pristine.zip'], 'no partial files may remain');
    } finally {
      restore();
    }
  });
});

test('a sha256 mismatch fails the download, deletes the partial file and caches nothing', async () => {
  const wrongBytes = Buffer.from('tampered asset bytes');
  const { restore } = mockMirrorFetch(
    githubListing([ASSET_NAME, 'SHA256SUMS']),
    `${MIRROR_ZIP_SHA256}  ${ASSET_NAME}\n`,
    wrongBytes,
  );

  await withTempDir(async (dir) => {
    const destination = path.join(dir, 'pristine.zip');
    try {
      await assert.rejects(downloadPristineMirrorImage(makeJob(), destination), (error: unknown) => {
        assert.ok(error instanceof OsImageError);
        assert.equal(error.statusCode, 502);
        assert.match(error.message, /sha256 mismatch/);
        return true;
      });

      assert.deepEqual(await fsp.readdir(dir), [], 'neither the destination nor partial files may remain');
    } finally {
      restore();
    }
  });
});

test('a missing SHA256SUMS entry fails closed with an error naming the checksum', async () => {
  const { restore } = mockMirrorFetch(
    githubListing([ASSET_NAME, 'SHA256SUMS']),
    `${'a'.repeat(64)}  other-asset.img.zip\n`,
    MIRROR_ZIP_BYTES,
  );

  await withTempDir(async (dir) => {
    const destination = path.join(dir, 'pristine.zip');
    try {
      await assert.rejects(downloadPristineMirrorImage(makeJob(), destination), (error: unknown) => {
        assert.ok(error instanceof OsImageError);
        assert.match(error.message, /SHA256SUMS/);
        assert.match(error.message, /refusing to use an unverified image/);
        return true;
      });

      assert.deepEqual(await fsp.readdir(dir), [], 'unverified bytes must not be cached');
    } finally {
      restore();
    }
  });
});

test('a release without any SHA256SUMS asset fails closed before downloading', async () => {
  const { calls, restore } = mockMirrorFetch(githubListing([ASSET_NAME]), '', MIRROR_ZIP_BYTES);

  await withTempDir(async (dir) => {
    const destination = path.join(dir, 'pristine.zip');
    try {
      await assert.rejects(downloadPristineMirrorImage(makeJob(), destination), (error: unknown) => {
        assert.ok(error instanceof OsImageError);
        assert.match(error.message, /SHA256SUMS entry/);
        return true;
      });

      assert.deepEqual(await fsp.readdir(dir), []);
      assert.ok(!calls.some((url) => url.endsWith('.img.zip')), 'the asset itself must not be fetched');
    } finally {
      restore();
    }
  });
});

// --- runOsImageJob end-to-end (download → extract → inject → recompress) ----------------

// balena-config-json is CommonJS and tsx compiles these files to CJS as well, so the
// require cache is shared: patching write() here intercepts the injection step the job
// performs (configJson.write(workingImage, undefined, config)). Without this seam a full
// run would need a real FAT-partitioned disk image fixture.
const configJsonModule = createRequire(import.meta.url)('balena-config-json') as {
  write: (image: string, configJsonPath: string | undefined, config: Record<string, unknown>) => Promise<void>;
};

const GATEWAY_KEY = 'sk-ssh-ed25519@openssh.com AAAAC3NzaC1lZDI1NTE5AAAAI gateway-yubikey';

/** Mock fetch serving the full mirror + openBalena surface; records every call URL. */
const mockJobFetch = (assetBytes: Buffer, assetSha256: string): { calls: string[]; restore: () => void } => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify(githubListing([ASSET_NAME, 'SHA256SUMS'])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/SHA256SUMS')) {
      return new Response(`${assetSha256}  ${ASSET_NAME}\n`, { status: 200 });
    }
    if (url.endsWith('/download-config')) {
      return new Response(JSON.stringify({ applicationId: 42, apiKey: 'cfg' }), { status: 200 });
    }
    return new Response(assetBytes, {
      status: 200,
      headers: { 'Content-Length': String(assetBytes.length) },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
};

const withJobEnv = async (fn: () => Promise<void>): Promise<void> => {
  const previousKeys = process.env.GATEWAY_SSH_PUBLIC_KEYS;
  const previousApiUrl = process.env.REACT_APP_OPEN_BALENA_API_URL;
  process.env.GATEWAY_SSH_PUBLIC_KEYS = GATEWAY_KEY;
  process.env.REACT_APP_OPEN_BALENA_API_URL = 'https://api.openbalena.local';
  try {
    await fn();
  } finally {
    if (previousKeys === undefined) {
      delete process.env.GATEWAY_SSH_PUBLIC_KEYS;
    } else {
      process.env.GATEWAY_SSH_PUBLIC_KEYS = previousKeys;
    }
    if (previousApiUrl === undefined) {
      delete process.env.REACT_APP_OPEN_BALENA_API_URL;
    } else {
      process.env.REACT_APP_OPEN_BALENA_API_URL = previousApiUrl;
    }
  }
};

const waitForJobToSettle = async (jobId: string): Promise<OsImageJob> => {
  for (let attempt = 0; attempt < 250; attempt++) {
    const job = getOsImageJob(jobId);
    assert.ok(job);
    if (job.phase === 'ready' || job.phase === 'error') {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job did not settle in time');
};

test('runOsImageJob drives download → extract → inject → recompress in order', async () => {
  const image = Buffer.alloc(2048, 5);
  const mirrorZip = makeZip([{ name: 'balena-image.img', data: image }]);
  const mirrorZipSha256 = createHash('sha256').update(mirrorZip).digest('hex');
  const { calls, restore } = mockJobFetch(mirrorZip, mirrorZipSha256);

  const capturedConfigs: Record<string, unknown>[] = [];
  const originalWrite = configJsonModule.write;
  configJsonModule.write = (async (_image, _path, config) => {
    capturedConfigs.push(config);
  }) as typeof configJsonModule.write;

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'obui-os-image-job-'));
  try {
    await withJobEnv(async () => {
      const job = createOsImageJob({ ...baseRequest, format: 'gz' }, 'Bearer caller-jwt', new CacheStore(dir));
      const settled = await waitForJobToSettle(job.jobId);

      assert.equal(settled.phase, 'ready', settled.error ?? 'job must succeed');
      // The injection step ran once, after the mirror download, carrying the gateway keys.
      assert.equal(capturedConfigs.length, 1);
      assert.deepEqual(capturedConfigs[0], {
        applicationId: 42,
        apiKey: 'cfg',
        os: { sshKeys: [GATEWAY_KEY] },
      });
      // Ordering: listing → sums → asset → fleet config generation.
      assert.match(calls[0], /^https:\/\/api\.github\.com\//);
      assert.ok(calls[1].endsWith('/SHA256SUMS'));
      assert.ok(calls[2].endsWith('.img.zip'));
      assert.ok(calls[3].endsWith('/download-config'));

      // The recompressed artifact is committed and the working image cleaned up.
      assert.ok(settled.artifact);
      assert.equal(settled.artifact?.filename, 'raspberrypi4-64-3.2.7-My-Fleet.gz');
      const outFiles = await fsp.readdir(path.join(dir, 'out'));
      assert.equal(outFiles.length, 1);
      assert.match(outFiles[0], /\.gz$/);
      assert.deepEqual(await fsp.readdir(path.join(dir, 'tmp')), [], 'working image must be removed');
    });
  } finally {
    configJsonModule.write = originalWrite;
    restore();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('runOsImageJob fails at unzip with a typed corrupt-archive error and cleans the working image', async () => {
  // The archive hash matches, but the entry lies about its uncompressed size: the
  // oversize-inflation guard fires during extraction (unzip), after the download.
  const lyingZip = makeZip([{ name: 'balena-image.img', data: Buffer.alloc(4096, 9), declaredUncompressedSize: 1 }]);
  const lyingZipSha256 = createHash('sha256').update(lyingZip).digest('hex');
  const { calls, restore } = mockJobFetch(lyingZip, lyingZipSha256);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'obui-os-image-job-'));
  try {
    await withJobEnv(async () => {
      const job = createOsImageJob({ ...baseRequest }, 'Bearer caller-jwt', new CacheStore(dir));
      const settled = await waitForJobToSettle(job.jobId);

      assert.equal(settled.phase, 'error');
      assert.match(settled.error ?? '', /inflated past its declared size/);
      // The verified pristine zip stays cached; no artifact is produced.
      assert.ok(
        calls.some((url) => url.endsWith('.img.zip')),
        'the asset download must have happened',
      );
      assert.equal((await fsp.readdir(path.join(dir, 'img'))).length, 1);
      assert.deepEqual(await fsp.readdir(path.join(dir, 'out')), []);
      assert.deepEqual(await fsp.readdir(path.join(dir, 'tmp')), [], 'working image must be removed');
    });
  } finally {
    restore();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a timed-out asset download surfaces as a typed 502 with a bounded signal', async () => {
  assert.equal(MIRROR_ASSET_DOWNLOAD_TIMEOUT_MS, 10 * 60 * 1000);
  const originalFetch = globalThis.fetch;
  const assetSignals: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify(githubListing([ASSET_NAME, 'SHA256SUMS'])), { status: 200 });
    }
    if (url.endsWith('/SHA256SUMS')) {
      return new Response(`${MIRROR_ZIP_SHA256}  ${ASSET_NAME}\n`, { status: 200 });
    }
    assetSignals.push(init?.signal);
    throw new DOMException('signal timed out', 'TimeoutError');
  }) as typeof fetch;

  try {
    await withTempDir(async (dir) => {
      await assert.rejects(downloadPristineMirrorImage(makeJob(), path.join(dir, 'pristine.zip')), (error: unknown) => {
        assert.ok(error instanceof OsImageError);
        assert.equal(error.statusCode, 502);
        assert.match(error.message, /signal timed out/);
        return true;
      });
      assert.equal(assetSignals.length, 1);
      assert.ok(assetSignals[0] instanceof AbortSignal, 'the asset download must be timeout-bounded');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

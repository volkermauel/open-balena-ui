import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  artifactDownloadFilename,
  downloadPristineMirrorImage,
  toFleetConfigOptions,
  type OsImageJobEntry,
  type PrepareOsImageRequest,
} from '../../server/controller/osImage/prepareJob';
import { clearMirrorCatalogCache } from '../../server/controller/osImage/versions';
import { configSha16, isValidDeviceTypeSlug, isValidOsVersion } from '../../server/controller/osImage/cacheStore';
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

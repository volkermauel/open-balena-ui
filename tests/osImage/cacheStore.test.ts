import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CacheStore,
  artifactFilename,
  cacheMaxBytes,
  cacheRootDir,
  canonicalizeConfig,
  configSha16,
  parseCacheFilename,
  pristineFilename,
  type FleetConfigOptions,
  type OsImageFormat,
  type OsImageVariant,
} from '../../server/controller/osImage/cacheStore';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const baseConfig: FleetConfigOptions = {
  appId: 42,
  version: '3.2.7',
  network: 'ethernet',
};

test('pristineFilename uses the documented key layout (verified zip archive)', () => {
  assert.equal(pristineFilename('raspberrypi4-64', '3.2.7', 'production'), 'raspberrypi4-64__3.2.7__prod.zip');
  assert.equal(pristineFilename('raspberrypi4-64', '3.2.7', 'development'), 'raspberrypi4-64__3.2.7__dev.zip');
});

test('artifactFilename includes variant token, config hash and format', () => {
  assert.equal(
    artifactFilename('raspberrypi4-64', '3.2.7', 'production', '0123456789abcdef', 'zip'),
    'raspberrypi4-64__3.2.7__prod__0123456789abcdef.zip',
  );
  assert.equal(
    artifactFilename('fincm3', '2.9.1+rev1', 'development', 'fedcba9876543210', 'gz'),
    'fincm3__2.9.1+rev1__dev__fedcba9876543210.gz',
  );
});

test('parseCacheFilename round-trips pristine and artifact keys', () => {
  // Pristine keys now hold the verified mirror .zip; the legacy .img layout
  // (balenaCloud-sourced, pre-mirror) still parses for files aging out on disk.
  assert.deepEqual(parseCacheFilename('raspberrypi4-64__3.2.7__prod.zip'), {
    deviceType: 'raspberrypi4-64',
    version: '3.2.7',
    variant: 'production',
    format: 'zip',
  });
  assert.deepEqual(parseCacheFilename('raspberrypi4-64__3.2.7__prod.img'), {
    deviceType: 'raspberrypi4-64',
    version: '3.2.7',
    variant: 'production',
    format: 'img',
  });
  assert.deepEqual(parseCacheFilename('fincm3__2.9.1+rev1__dev__fedcba9876543210.gz'), {
    deviceType: 'fincm3',
    version: '2.9.1+rev1',
    variant: 'development',
    configSha16: 'fedcba9876543210',
    format: 'gz',
  });
  assert.equal(parseCacheFilename('not-a-cache-file.txt'), null);
});

test('canonicalizeConfig sorts keys and omits undefined values', () => {
  const a: FleetConfigOptions = {
    appId: 42,
    version: '3.2.7',
    network: 'wifi',
    appUpdatePollInterval: 10,
    wifiSsid: 'net',
    wifiKey: undefined,
  };
  const b: FleetConfigOptions = {
    wifiKey: undefined,
    network: 'wifi',
    wifiSsid: 'net',
    version: '3.2.7',
    appUpdatePollInterval: 10,
    appId: 42,
  };

  const canonicalA = canonicalizeConfig(a);
  const canonicalB = canonicalizeConfig(b);

  assert.equal(canonicalA, canonicalB);
  assert.ok(!canonicalA.includes('wifiKey'));
  const keys = Object.keys(JSON.parse(canonicalA) as Record<string, unknown>);
  assert.deepEqual(keys, [...keys].sort());
});

test('configSha16 is stable for identical options and varies with format', () => {
  const productionZip = configSha16({ ...baseConfig, network: 'ethernet' }, 'zip');
  const reordered = configSha16(
    {
      network: 'ethernet',
      version: '3.2.7',
      appId: 42,
    },
    'zip',
  );

  assert.equal(productionZip, reordered);
  assert.match(productionZip, /^[0-9a-f]{16}$/);
  assert.notEqual(productionZip, configSha16({ ...baseConfig }, 'gz'));
  assert.notEqual(productionZip, configSha16({ ...baseConfig, appId: 43 }, 'zip'));
  assert.notEqual(productionZip, configSha16({ ...baseConfig, developmentMode: true }, 'zip'));
});

test('cache env defaults and overrides', () => {
  const previousDir = process.env.OS_IMAGE_CACHE_DIR;
  const previousMax = process.env.OS_IMAGE_CACHE_MAX_GB;

  try {
    delete process.env.OS_IMAGE_CACHE_DIR;
    delete process.env.OS_IMAGE_CACHE_MAX_GB;
    assert.equal(cacheRootDir(), './os-image-cache');
    assert.equal(cacheMaxBytes(), 20 * 1024 ** 3);

    process.env.OS_IMAGE_CACHE_DIR = '/tmp/custom-cache';
    process.env.OS_IMAGE_CACHE_MAX_GB = '0.001';
    assert.equal(cacheRootDir(), '/tmp/custom-cache');
    assert.equal(cacheMaxBytes(), Math.floor(0.001 * 1024 ** 3));

    process.env.OS_IMAGE_CACHE_MAX_GB = 'not-a-number';
    assert.equal(cacheMaxBytes(), 20 * 1024 ** 3);
  } finally {
    if (previousDir === undefined) {
      delete process.env.OS_IMAGE_CACHE_DIR;
    } else {
      process.env.OS_IMAGE_CACHE_DIR = previousDir;
    }
    if (previousMax === undefined) {
      delete process.env.OS_IMAGE_CACHE_MAX_GB;
    } else {
      process.env.OS_IMAGE_CACHE_MAX_GB = previousMax;
    }
  }
});

interface CacheStoreTestContext {
  rootDir: string;
  store: CacheStore;
}

const withTempStore = async (
  maxBytes: number,
  fn: (context: CacheStoreTestContext) => Promise<void>,
): Promise<void> => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'obui-os-image-cache-'));
  try {
    const store = new CacheStore(rootDir, maxBytes);
    await store.ensureDirs();
    await fn({ rootDir, store });
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
};

const writeCacheFile = async (filePath: string, sizeBytes: number): Promise<void> => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, Buffer.alloc(sizeBytes, 1));
};

test('LRU eviction enforces the cap oldest-first', async () => {
  await withTempStore(10_000, async ({ store }) => {
    const a = store.pristinePath('dt', '1.0.0', 'production');
    const b = store.pristinePath('dt', '2.0.0', 'production');
    const c = store.pristinePath('dt', '3.0.0', 'production');

    await writeCacheFile(a, 4_000);
    await store.register(a);
    await sleep(5);
    await writeCacheFile(b, 4_000);
    await store.register(b);
    await sleep(5);
    await writeCacheFile(c, 4_000);
    await store.register(c);

    assert.equal(await store.hasFile(a), false, 'oldest file should be evicted');
    assert.equal(await store.hasFile(b), true);
    assert.equal(await store.hasFile(c), true);
  });
});

test('LRU eviction never removes files protected by running jobs', async () => {
  await withTempStore(10_000, async ({ store }) => {
    const a = store.pristinePath('dt', '1.0.0', 'production');
    const b = store.pristinePath('dt', '2.0.0', 'production');
    const c = store.pristinePath('dt', '3.0.0', 'production');
    const d = store.pristinePath('dt', '4.0.0', 'production');

    await writeCacheFile(a, 4_000);
    await store.register(a);
    await sleep(5);
    await writeCacheFile(b, 4_000);
    await store.register(b);
    await sleep(5);
    await writeCacheFile(c, 4_000);
    await store.register(c);
    assert.equal(await store.hasFile(a), false);

    // Protect b as if a running job depends on it; the next overflow must evict c instead.
    store.protect([b]);
    await sleep(5);
    await writeCacheFile(d, 4_000);
    await store.register(d);

    assert.equal(await store.hasFile(b), true, 'protected file must survive eviction');
    assert.equal(await store.hasFile(c), false, 'next LRU candidate evicted instead');
    assert.equal(await store.hasFile(d), true);

    // After the job finishes the file becomes evictable again.
    store.unprotect([b]);
    await sleep(5);
    const e = store.pristinePath('dt', '5.0.0', 'production');
    await writeCacheFile(e, 4_000);
    await store.register(e);

    assert.equal(await store.hasFile(b), false, 'unprotected file evicted on next overflow');
  });
});

test('touch refreshes the LRU clock of an existing entry', async () => {
  await withTempStore(10_000, async ({ store }) => {
    const a = store.pristinePath('dt', '1.0.0', 'production');
    const b = store.pristinePath('dt', '2.0.0', 'production');

    await writeCacheFile(a, 4_000);
    await store.register(a);
    await sleep(5);
    await writeCacheFile(b, 4_000);
    await store.register(b);
    await sleep(5);
    await store.touch(a);
    await sleep(5);

    const c = store.pristinePath('dt', '3.0.0', 'production');
    await writeCacheFile(c, 4_000);
    await store.register(c);

    assert.equal(await store.hasFile(a), true, 'touched file survives');
    assert.equal(await store.hasFile(b), false, 'untouched LRU file evicted');
  });
});

test('commitFile moves a tmp file into place atomically and registers it', async () => {
  await withTempStore(1_000_000, async ({ store }) => {
    const artifact = store.artifactPath('dt', '1.0.0', 'production', '0123456789abcdef', 'zip');
    const tmp = store.tmpPath('job.img');
    await writeCacheFile(tmp, 1_024);

    await store.commitFile(tmp, artifact);

    assert.equal(await store.hasFile(tmp), false);
    assert.equal(await store.hasFile(artifact), true);
    assert.equal(await store.fileSize(artifact), 1_024);
  });
});

test('withLock serializes work per cache key', async () => {
  await withTempStore(1_000_000, async ({ store }) => {
    let active = 0;
    let maxActive = 0;

    const task = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(10);
      active -= 1;
    };

    await Promise.all([
      store.withLock('key', task),
      store.withLock('key', task),
      store.withLock('key', task),
      store.withLock('other-key', task),
    ]);

    assert.equal(maxActive, 2, 'same-key tasks serialize; different keys run concurrently');
  });
});

test('cacheStatus reports cached versions per variant with artifact counts and sizes', async () => {
  await withTempStore(1_000_000, async ({ store }) => {
    await writeCacheFile(store.pristinePath('raspberrypi4-64', '3.2.7', 'production'), 100);
    await writeCacheFile(store.pristinePath('raspberrypi4-64', '3.2.7', 'development'), 50);
    await writeCacheFile(store.artifactPath('raspberrypi4-64', '3.2.7', 'production', '0123456789abcdef', 'zip'), 10);
    await writeCacheFile(store.artifactPath('raspberrypi4-64', '3.2.6', 'production', '0123456789abcdef', 'gz'), 20);
    await writeCacheFile(store.artifactPath('other-device', '1.0.0', 'production', '0123456789abcdef', 'zip'), 999);

    const status = await store.cacheStatus('raspberrypi4-64');

    assert.deepEqual(status, [
      { version: '3.2.7', variant: 'development', cached: true, artifactCount: 0, totalBytes: 50 },
      { version: '3.2.7', variant: 'production', cached: true, artifactCount: 1, totalBytes: 110 },
      { version: '3.2.6', variant: 'production', cached: true, artifactCount: 1, totalBytes: 20 },
    ]);

    const empty = await store.cacheStatus('unknown-device');
    assert.deepEqual(empty, []);
  });
});

const variantFormats: OsImageVariant[] = ['production', 'development'];
const formats: OsImageFormat[] = ['zip', 'gz'];

test('every variant/format combination yields distinct, parseable cache keys', async () => {
  for (const variant of variantFormats) {
    for (const format of formats) {
      const hash = configSha16(
        { ...baseConfig, ...(variant === 'development' ? { developmentMode: true } : {}) },
        format,
      );
      const name = artifactFilename('dt', '1.0.0', variant, hash, format);
      const parsed = parseCacheFilename(name);
      assert.ok(parsed);
      assert.equal(parsed.variant, variant);
      assert.equal(parsed.format, format);
      assert.equal(parsed.configSha16, hash);
    }
  }
});

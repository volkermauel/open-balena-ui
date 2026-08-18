import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OsImageError } from './errors';

export type OsImageVariant = 'production' | 'development';
export type OsImageFormat = 'zip' | 'gz';
export type OsImageNetwork = 'ethernet' | 'wifi';

/**
 * The fleet provisioning options that flow into openBalena's `POST /download-config`.
 * They double as the cache key input: identical options reuse an identical artifact.
 */
export interface FleetConfigOptions {
  appId: number;
  version: string;
  network: OsImageNetwork;
  appUpdatePollInterval?: number;
  developmentMode?: boolean;
  wifiSsid?: string;
  wifiKey?: string;
}

export interface CachedVersionInfo {
  version: string;
  variant: OsImageVariant;
  cached: boolean;
  artifactCount: number;
  totalBytes: number;
}

export const DEFAULT_CACHE_DIR = './os-image-cache';
export const DEFAULT_CACHE_MAX_GB = 20;

export const cacheRootDir = (): string => process.env.OS_IMAGE_CACHE_DIR || DEFAULT_CACHE_DIR;

export const cacheMaxBytes = (): number => {
  const maxGb = Number(process.env.OS_IMAGE_CACHE_MAX_GB);
  if (Number.isFinite(maxGb) && maxGb > 0) {
    return Math.floor(maxGb * 1024 ** 3);
  }
  return DEFAULT_CACHE_MAX_GB * 1024 ** 3;
};

export const variantToken = (variant: OsImageVariant): 'prod' | 'dev' => (variant === 'development' ? 'dev' : 'prod');

export const variantFromToken = (token: string): OsImageVariant => (token === 'dev' ? 'development' : 'production');
/** Device type slugs: letters, digits, dots, hyphens (e.g. `raspberrypi4-64`). */
export const isValidDeviceTypeSlug = (deviceType: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(deviceType) && deviceType.length <= 64;

/** balenaOS versions: semver-ish, optionally with `+revN` builds (e.g. `7.4.0+rev5`). */
export const isValidOsVersion = (version: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(version) && version.length <= 64;

/** Pristine (unconfigured) cache key: the sha256-verified mirror asset, `{deviceType}__{version}__{prod|dev}.zip` */
export const pristineFilename = (deviceType: string, version: string, variant: OsImageVariant): string =>
  `${deviceType}__${version}__${variantToken(variant)}.zip`;

/** Configured artifact cache key: `{deviceType}__{version}__{prod|dev}__{sha16}.{zip|gz}` */
export const artifactFilename = (
  deviceType: string,
  version: string,
  variant: OsImageVariant,
  configSha16: string,
  format: OsImageFormat,
): string => `${deviceType}__${version}__${variantToken(variant)}__${configSha16}.${format}`;

const canonicalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const entry = (value as Record<string, unknown>)[key];
        if (entry !== undefined) {
          acc[key] = canonicalizeValue(entry);
        }
        return acc;
      }, {});
  }
  return value;
};

/**
 * Canonical JSON serialization of the fleet config options: object keys sorted, `undefined`
 * values omitted. Used so that structurally identical options produce an identical string
 * regardless of property order.
 */
export const canonicalizeConfig = (config: FleetConfigOptions): string =>
  JSON.stringify(canonicalizeValue({ ...config }));

/**
 * First 16 hex characters of the SHA-256 over the canonicalized config JSON plus the
 * artifact format. Identical settings (and format) always map onto the same artifact file.
 */
export const configSha16 = (config: FleetConfigOptions, format: OsImageFormat): string =>
  createHash('sha256')
    .update(`${canonicalizeConfig(config)}\n${format}`)
    .digest('hex')
    .slice(0, 16);

interface CacheIndexEntry {
  size: number;
  lastUsed: number;
}

interface ParsedCacheFilename {
  deviceType: string;
  version: string;
  variant: OsImageVariant;
  configSha16?: string;
  format: 'img' | OsImageFormat;
}

export const parseCacheFilename = (filename: string): ParsedCacheFilename | null => {
  const match = /^(.+)__(.+)__(prod|dev)(?:__([0-9a-f]{16}))?\.(img|zip|gz)$/.exec(filename);
  if (!match) {
    return null;
  }
  const [, deviceType, version, variant, configSha16, extension] = match;
  return {
    deviceType,
    version,
    variant: variantFromToken(variant),
    ...(configSha16 ? { configSha16 } : {}),
    format: extension as 'img' | OsImageFormat,
  };
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    return (await fsp.stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const compareCachedVersionDesc = (a: CachedVersionInfo, b: CachedVersionInfo): number => {
  if (a.version !== b.version) {
    return b.version.localeCompare(a.version, undefined, { numeric: true });
  }
  return a.variant.localeCompare(b.variant);
};

/**
 * Two-tier, LRU-evicted, size-capped on-disk cache for OS images:
 *
 * - `img/` pristine mirror archives (verified zips) downloaded at most once per (device type, version, variant)
 * - `out/` configured, compressed artifacts keyed by the config hash
 * - `tmp/` in-flight scratch files (callers must clean up)
 *
 * Eviction considers both tiers, removes least-recently-used files first, and never touches
 * files explicitly protected by a running job. Per-key locks deduplicate concurrent
 * downloads of the same pristine image.
 */
export class CacheStore {
  private readonly explicitRootDir?: string;
  private readonly explicitMaxBytes?: number;
  private readonly index = new Map<string, CacheIndexEntry>();
  private readonly protectedPaths = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private indexed = false;

  constructor(rootDir?: string, maxBytes?: number) {
    if (rootDir) {
      this.explicitRootDir = rootDir;
    }
    if (typeof maxBytes === 'number') {
      this.explicitMaxBytes = maxBytes;
    }
  }

  public get rootDir(): string {
    return this.explicitRootDir ?? cacheRootDir();
  }

  public get maxBytes(): number {
    return this.explicitMaxBytes ?? cacheMaxBytes();
  }

  public get imgDir(): string {
    return path.join(this.rootDir, 'img');
  }

  public get outDir(): string {
    return path.join(this.rootDir, 'out');
  }

  public get tmpDir(): string {
    return path.join(this.rootDir, 'tmp');
  }

  public pristinePath = (deviceType: string, version: string, variant: OsImageVariant): string =>
    path.join(this.imgDir, pristineFilename(deviceType, version, variant));

  public artifactPath = (
    deviceType: string,
    version: string,
    variant: OsImageVariant,
    configSha: string,
    format: OsImageFormat,
  ): string => path.join(this.outDir, artifactFilename(deviceType, version, variant, configSha, format));

  public tmpPath = (name: string): string => path.join(this.tmpDir, name);

  public async ensureDirs(): Promise<void> {
    await fsp.mkdir(this.imgDir, { recursive: true });
    await fsp.mkdir(this.outDir, { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
  }

  public hasFile = async (filePath: string): Promise<boolean> => fileExists(filePath);

  public fileSize = async (filePath: string): Promise<number> => {
    try {
      return (await fsp.stat(filePath)).size;
    } catch {
      throw new OsImageError(404, `Cache file not found: ${path.basename(filePath)}`);
    }
  };

  /** Mark files as in use by a running job so eviction cannot remove them. */
  public protect = (filePaths: string[]): void => {
    for (const filePath of filePaths) {
      this.protectedPaths.add(filePath);
    }
  };

  public unprotect = (filePaths: string[]): void => {
    for (const filePath of filePaths) {
      this.protectedPaths.delete(filePath);
    }
  };

  public isProtected = (filePath: string): boolean => this.protectedPaths.has(filePath);

  /**
   * Serialize async work per cache key: while a download for `key` is in flight, later
   * callers await the same critical section instead of starting their own download.
   */
  public withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const tail = this.locks.get(key) ?? Promise.resolve();
    const result = tail.then(() => task());
    const nextTail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, nextTail);
    void nextTail.then(() => {
      if (this.locks.get(key) === nextTail) {
        this.locks.delete(key);
      }
    });
    return result;
  }

  /** Atomically move a finished tmp/ file into place and register it with the LRU index. */
  public async commitFile(tmpFile: string, destination: string): Promise<void> {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.rename(tmpFile, destination);
    await this.register(destination);
  }

  /**
   * Add (or refresh) a file in the LRU index and enforce the size cap. Must be called after
   * every new file lands in `img/` or `out/`.
   */
  public async register(filePath: string): Promise<void> {
    await this.ensureIndexed();
    const stats = await fsp.stat(filePath);
    this.index.set(filePath, { size: stats.size, lastUsed: Date.now() });
    await this.enforceCap();
  }

  /** Refresh the LRU clock for an existing entry (e.g. an artifact was just served). */
  public async touch(filePath: string): Promise<void> {
    await this.ensureIndexed();
    if (this.index.has(filePath)) {
      this.index.set(filePath, { ...this.index.get(filePath)!, lastUsed: Date.now() });
    } else if (await fileExists(filePath)) {
      await this.register(filePath);
    }
  }

  /** Evict least-recently-used files until total cache size fits within the cap. */
  public async enforceCap(): Promise<void> {
    await this.ensureIndexed();

    const totalBytes = (): number => Array.from(this.index.values()).reduce((sum, entry) => sum + entry.size, 0);

    const candidates = Array.from(this.index.entries())
      .map(([filePath, entry]) => ({ filePath, ...entry }))
      .sort((a, b) => a.lastUsed - b.lastUsed);

    for (const candidate of candidates) {
      if (totalBytes() <= this.maxBytes) {
        return;
      }
      if (this.protectedPaths.has(candidate.filePath)) {
        continue;
      }
      this.index.delete(candidate.filePath);
      try {
        await fsp.unlink(candidate.filePath);
      } catch {
        // File already gone; it is no longer in the index either way.
      }
    }
  }

  /**
   * Snapshot of the cached versions for a device type: which (version, variant) pairs have
   * a pristine image and/or at least one configured artifact, plus artifact counts and sizes.
   */
  public async cacheStatus(deviceType: string): Promise<CachedVersionInfo[]> {
    await this.ensureDirs();

    const tiers = await Promise.all([this.listDir(this.imgDir), this.listDir(this.outDir)]);
    const stats = new Map<
      string,
      { version: string; variant: OsImageVariant; pristine: boolean; artifacts: number; totalBytes: number }
    >();

    const record = (parsed: ParsedCacheFilename, size: number, isPristine: boolean): void => {
      if (parsed.deviceType !== deviceType) {
        return;
      }
      const key = `${parsed.version}__${parsed.variant}`;
      const entry = stats.get(key) ?? {
        version: parsed.version,
        variant: parsed.variant,
        pristine: false,
        artifacts: 0,
        totalBytes: 0,
      };
      if (isPristine) {
        entry.pristine = true;
      } else {
        entry.artifacts += 1;
      }
      entry.totalBytes += size;
      stats.set(key, entry);
    };

    for (const [dir, filenames, isPristine] of [
      [this.imgDir, tiers[0], true],
      [this.outDir, tiers[1], false],
    ] as const) {
      for (const filename of filenames) {
        const parsed = parseCacheFilename(filename);
        if (!parsed) {
          continue;
        }
        try {
          const size = (await fsp.stat(path.join(dir, filename))).size;
          record(parsed, size, isPristine);
        } catch {
          // Raced with an eviction; skip.
        }
      }
    }

    return Array.from(stats.values())
      .map(
        (entry): CachedVersionInfo => ({
          version: entry.version,
          variant: entry.variant,
          cached: entry.pristine || entry.artifacts > 0,
          artifactCount: entry.artifacts,
          totalBytes: entry.totalBytes,
        }),
      )
      .sort((a, b) => compareCachedVersionDesc(a, b));
  }

  private async listDir(dir: string): Promise<string[]> {
    try {
      return await fsp.readdir(dir);
    } catch {
      return [];
    }
  }

  private async ensureIndexed(): Promise<void> {
    if (this.indexed) {
      return;
    }
    this.index.clear();

    for (const dir of [this.imgDir, this.outDir]) {
      let filenames: string[] = [];
      try {
        filenames = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const filename of filenames) {
        const filePath = path.join(dir, filename);
        try {
          const stats = await fsp.stat(filePath);
          if (stats.isFile()) {
            this.index.set(filePath, { size: stats.size, lastUsed: stats.mtimeMs });
          }
        } catch {
          // Raced with an eviction; skip.
        }
      }
    }

    this.indexed = true;
  }
}

/** Server-wide cache store instance, configured from the environment. */
export const osImageCacheStore = new CacheStore();

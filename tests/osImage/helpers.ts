import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export interface ZipFixtureEntry {
  name: string;
  data: Buffer;
  /** Store uncompressed (no deflate) when true. */
  store?: boolean;
  /**
   * Uncompressed size the central directory declares. Defaults to the real size;
   * tests set a bogus smaller value to exercise the oversize-inflation guard.
   */
  declaredUncompressedSize?: number;
}

/**
 * Minimal ZIP writer for fixtures: local file headers followed by a central
 * directory and EOCD, mirroring what the mirror's release zips look like
 * (deflate or stored entries, no data descriptors, sizes in the directory).
 */
export const makeZip = (entries: ZipFixtureEntry[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = zlib.crc32(entry.data) >>> 0;
    const stored = entry.store === true;
    const payload = stored ? entry.data : zlib.deflateRawSync(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8); // compression method
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.declaredUncompressedSize ?? entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(Buffer.concat(locals).length, 16);

  return Buffer.concat([...locals, centralDirectory, eocd]);
};

/**
 * Minimal zip64 variant of {@link makeZip}: the local file header keeps the real
 * sizes, but the central directory entry replaces them with 0xFFFFFFFF placeholders
 * (plus a zip64 extra field carrying the true values) and the classic EOCD carries
 * 0xFFFF/0xFFFFFFFF placeholders backed by a zip64 EOCD locator + EOCD record.
 * Layout: [locals][CD][zip64 EOCD][zip64 locator][classic EOCD].
 */
export const makeZip64 = (entries: ZipFixtureEntry[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = zlib.crc32(entry.data) >>> 0;
    const payload = zlib.deflateRawSync(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8); // compression method
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, payload);

    // zip64 extra field (header id 0x0001): uncompressed, compressed, local offset.
    const extra = Buffer.alloc(4 + 24);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(entry.data.length), 4);
    extra.writeBigUInt64LE(BigInt(payload.length), 12);
    extra.writeBigUInt64LE(BigInt(offset), 20);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(0xffffffff, 20); // placeholder → zip64 extra
    central.writeUInt32LE(0xffffffff, 24); // placeholder → zip64 extra
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(0xffffffff, 42); // placeholder → zip64 extra
    centrals.push(central, nameBytes, extra);

    offset += 30 + nameBytes.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const zip64EocdOffset = Buffer.concat(locals).length + centralDirectory.length;

  const zip64Eocd = Buffer.alloc(56);
  zip64Eocd.writeUInt32LE(0x06064b50, 0);
  zip64Eocd.writeBigUInt64LE(BigInt(entries.length), 32); // total entries
  zip64Eocd.writeBigUInt64LE(BigInt(centralDirectory.length), 40); // CD size
  zip64Eocd.writeBigUInt64LE(BigInt(zip64EocdOffset - centralDirectory.length), 48); // CD offset

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 10); // placeholder → zip64 EOCD
  eocd.writeUInt32LE(0xffffffff, 12); // placeholder → zip64 EOCD
  eocd.writeUInt32LE(0xffffffff, 16); // placeholder → zip64 EOCD

  return Buffer.concat([...locals, centralDirectory, zip64Eocd, locator, eocd]);
};

export const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'obui-os-image-zip-'));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
};

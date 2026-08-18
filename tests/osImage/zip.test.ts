import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { extractZipEntry, pickImageEntry, readZipEntries } from '../../server/controller/osImage/zip';
import { OsImageError } from '../../server/controller/osImage/errors';

/**
 * Minimal ZIP writer for fixtures: local file headers followed by a central
 * directory and EOCD, mirroring what the mirror's release zips look like
 * (deflate or stored entries, no data descriptors, sizes in the directory).
 */
const makeZip = (entries: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer => {
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
    central.writeUInt32LE(entry.data.length, 24);
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

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'obui-os-image-zip-'));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
};

test('readZipEntries lists entries with directory sizes and crc', async () => {
  await withTempDir(async (dir) => {
    const zipPath = path.join(dir, 'image.zip');
    await fsp.writeFile(zipPath, makeZip([{ name: 'balena-image.img', data: Buffer.alloc(1024, 7) }]));

    const entries = await readZipEntries(zipPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'balena-image.img');
    assert.equal(entries[0].isDirectory, false);
    assert.equal(entries[0].compressionMethod, 8);
    assert.equal(entries[0].uncompressedSize, 1024);
    assert.equal(entries[0].crc32, zlib.crc32(Buffer.alloc(1024, 7)) >>> 0);
  });
});

test('pickImageEntry prefers the .img entry over sidecar files', () => {
  const entries = [
    {
      name: 'README.md',
      isDirectory: false,
      flags: 0,
      compressionMethod: 8,
      compressedSize: 10,
      uncompressedSize: 20,
      crc32: 0,
      localHeaderOffset: 0,
    },
    {
      name: 'img/balena-image.img',
      isDirectory: true,
      flags: 0,
      compressionMethod: 8,
      compressedSize: 0,
      uncompressedSize: 0,
      crc32: 0,
      localHeaderOffset: 0,
    },
    {
      name: 'balena-image.img',
      isDirectory: false,
      flags: 0,
      compressionMethod: 8,
      compressedSize: 100,
      uncompressedSize: 4096,
      crc32: 1,
      localHeaderOffset: 0,
    },
  ];
  assert.equal(pickImageEntry(entries).name, 'balena-image.img');
});

test('pickImageEntry fails for archives without an image, except a single unambiguous file', () => {
  assert.throws(
    () => pickImageEntry([]),
    (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.match(error.message, /no image entry/);
      return true;
    },
  );

  const readme = {
    name: 'README.md',
    isDirectory: false,
    flags: 0,
    compressionMethod: 8,
    compressedSize: 10,
    uncompressedSize: 20,
    crc32: 0,
    localHeaderOffset: 0,
  };
  const sidecar = { ...readme, name: 'manifest.json' };
  assert.throws(() => pickImageEntry([readme, sidecar]), /no image entry/);
  assert.equal(pickImageEntry([readme]).name, 'README.md');
});

test('extractZipEntry inflates deflate entries and verifies size and crc', async () => {
  await withTempDir(async (dir) => {
    const payload = Buffer.alloc(64 * 1024, 3); // compressible content
    const zipPath = path.join(dir, 'image.zip');
    const destination = path.join(dir, 'out.img');
    await fsp.writeFile(zipPath, makeZip([{ name: 'balena-image.img', data: payload }]));

    const entry = pickImageEntry(await readZipEntries(zipPath));
    await extractZipEntry(zipPath, entry, destination);

    const extracted = await fsp.readFile(destination);
    assert.equal(extracted.length, payload.length);
    assert.ok(extracted.equals(payload));
  });
});

test('extractZipEntry copies stored entries byte-for-byte', async () => {
  await withTempDir(async (dir) => {
    const payload = Buffer.from('uncompressed image bytes', 'utf8');
    const zipPath = path.join(dir, 'stored.zip');
    const destination = path.join(dir, 'out.img');
    await fsp.writeFile(zipPath, makeZip([{ name: 'image.img', data: payload, store: true }]));

    const entry = pickImageEntry(await readZipEntries(zipPath));
    await extractZipEntry(zipPath, entry, destination);

    assert.ok((await fsp.readFile(destination)).equals(payload));
  });
});

test('extractZipEntry rejects a corrupted entry (crc mismatch)', async () => {
  await withTempDir(async (dir) => {
    const zip = makeZip([{ name: 'image.img', data: Buffer.from('correct bytes', 'utf8') }]);
    // Flip a payload byte inside the first local entry (offset 30 + name length).
    const corrupted = Buffer.from(zip);
    corrupted[30 + 'image.img'.length + 2] ^= 0xff;
    const zipPath = path.join(dir, 'corrupt.zip');
    await fsp.writeFile(zipPath, corrupted);

    const entry = pickImageEntry(await readZipEntries(zipPath));
    await assert.rejects(extractZipEntry(zipPath, entry, path.join(dir, 'out.img')), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /corrupt|CRC-32/);
      return true;
    });
  });
});

test('readZipEntries rejects a file that is not a zip archive', async () => {
  await withTempDir(async (dir) => {
    const zipPath = path.join(dir, 'not-a-zip.bin');
    await fsp.writeFile(zipPath, Buffer.from('this is definitely not a zip file'));
    await assert.rejects(readZipEntries(zipPath), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.match(error.message, /corrupt/);
      return true;
    });
  });
});

test('a round-tripped multi-entry archive extracts the right entry', async () => {
  await withTempDir(async (dir) => {
    const image = Buffer.alloc(4096, 9);
    const readme = Buffer.from('mirror readme', 'utf8');
    const zipPath = path.join(dir, 'multi.zip');
    const destination = path.join(dir, 'out.img');
    await fsp.writeFile(
      zipPath,
      makeZip([
        { name: 'README.md', data: readme },
        { name: 'balena-image.img', data: image },
      ]),
    );

    await extractZipEntry(zipPath, pickImageEntry(await readZipEntries(zipPath)), destination);

    const extracted = await fsp.readFile(destination);
    assert.equal(
      createHash('sha256').update(extracted).digest('hex'),
      createHash('sha256').update(image).digest('hex'),
    );
  });
});

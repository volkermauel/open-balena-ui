import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { extractZipEntry, pickImageEntry, readZipEntries } from '../../server/controller/osImage/zip';
import { OsImageError } from '../../server/controller/osImage/errors';
import { makeZip, makeZip64, withTempDir } from './helpers';

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

test('extractZipEntry aborts a deflate stream that inflates past its declared size', async () => {
  await withTempDir(async (dir) => {
    const payload = Buffer.alloc(64 * 1024, 3); // inflates far past the declared 1 B
    const zipPath = path.join(dir, 'lying.zip');
    const destination = path.join(dir, 'out.img');
    await fsp.writeFile(zipPath, makeZip([{ name: 'balena-image.img', data: payload, declaredUncompressedSize: 1 }]));

    const entry = pickImageEntry(await readZipEntries(zipPath));
    assert.equal(entry.uncompressedSize, 1);
    await assert.rejects(extractZipEntry(zipPath, entry, destination), (error: unknown) => {
      assert.ok(error instanceof OsImageError);
      assert.equal(error.statusCode, 502);
      // The in-flight guard fires — not the post-hoc size check after a full inflation.
      assert.match(error.message, /inflated past its declared size/);
      return true;
    });

    const leftover = await fsp.readFile(destination).catch(() => null);
    assert.ok(
      leftover === null || leftover.length < payload.length,
      'the destination must not be left with the full payload',
    );
  });
});

test('readZipEntries resolves zip64 placeholders through the zip64 EOCD and extra field', async () => {
  await withTempDir(async (dir) => {
    const payload = Buffer.alloc(4096, 11);
    const zipPath = path.join(dir, 'zip64.zip');
    const destination = path.join(dir, 'out.img');
    await fsp.writeFile(zipPath, makeZip64([{ name: 'balena-image.img', data: payload }]));

    const entries = await readZipEntries(zipPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'balena-image.img');
    // The 0xFFFFFFFF placeholders must be replaced by the zip64 extra-field values.
    assert.equal(entries[0].uncompressedSize, payload.length);
    assert.equal(entries[0].compressedSize, zlib.deflateRawSync(payload).length);
    assert.equal(entries[0].localHeaderOffset, 0);
    assert.equal(entries[0].crc32, zlib.crc32(payload) >>> 0);

    await extractZipEntry(zipPath, entries[0], destination);
    assert.ok((await fsp.readFile(destination)).equals(payload));
  });
});

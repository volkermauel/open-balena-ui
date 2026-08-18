import { createReadStream, createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import { Transform, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { OsImageError } from './errors';

const streamPipeline = promisify(pipeline);

/**
 * Minimal ZIP reader for the verified mirror archives: parses the central
 * directory (incl. zip64) and streams a single entry out through
 * `zlib.inflateRaw` (deflate) or a plain copy (stored), verifying the entry's
 * CRC-32 and uncompressed size. No third-party dependency — the mirror zips
 * are plain deflate archives produced by the release pipeline.
 */

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_ENTRY_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
/** EOCD + maximum comment + zip64 locator head we may need to scan. */
const MAX_ZIP_TAIL_SIZE = END_OF_CENTRAL_DIRECTORY_SIZE + 0xffff + 64;

export const COMPRESSION_METHOD_STORED = 0;
export const COMPRESSION_METHOD_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  /** General purpose bit flags (bit 0 = encrypted, bit 3 = data descriptor). */
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
}

const corruptZip = (detail: string): OsImageError =>
  new OsImageError(502, `Downloaded mirror archive is corrupt or unsupported: ${detail}`);

interface Zip64Sizes {
  entryCount: number;
  cdSize: number;
  cdOffset: number;
}

/**
 * Parse the zip64 EOCD when the classic EOCD carries 0xFFFF/0xFFFFFFFF
 * placeholders; returns the true counts. Pure — unit tested.
 */
export const parseZip64Tail = (locator: Buffer, zip64Eocd: Buffer): Zip64Sizes | null => {
  if (
    locator.length < 20 ||
    locator.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE ||
    zip64Eocd.length < 56 ||
    zip64Eocd.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE
  ) {
    return null;
  }
  return {
    entryCount: Number(zip64Eocd.readBigUInt64LE(32)),
    cdSize: Number(zip64Eocd.readBigUInt64LE(40)),
    cdOffset: Number(zip64Eocd.readBigUInt64LE(48)),
  };
};

/** Parse the classic EOCD record; null when the buffer holds none. Pure — unit tested. */
export const parseEndOfCentralDirectory = (
  tail: Buffer,
  fileSize: number,
): { entryCount: number; cdSize: number; cdOffset: number; eocdOffset: number } | null => {
  // Scan backwards for the EOCD signature; the record is at least 22 bytes.
  for (let offset = tail.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const entryCount = tail.readUInt16LE(offset + 10);
    const cdSize = tail.readUInt32LE(offset + 12);
    const cdOffset = tail.readUInt32LE(offset + 16);
    const eocdOffset = fileSize - tail.length + offset;
    return { entryCount, cdSize, cdOffset, eocdOffset };
  }
  return null;
};

const parseZip64ExtraFields = (extra: Buffer, entry: Omit<ZipEntry, 'name' | 'isDirectory'>): void => {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset);
    const dataSize = extra.readUInt16LE(offset + 2);
    const fieldEnd = offset + 4 + dataSize;
    if (fieldEnd > extra.length) {
      break;
    }
    if (headerId === 0x0001) {
      // Zip64 original sizes appear in order, each only when the base field is
      // the 0xFFFFFFFF placeholder.
      let cursor = offset + 4;
      if (entry.uncompressedSize === 0xffffffff && cursor + 8 <= fieldEnd) {
        entry.uncompressedSize = Number(extra.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.compressedSize === 0xffffffff && cursor + 8 <= fieldEnd) {
        entry.compressedSize = Number(extra.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.localHeaderOffset === 0xffffffff && cursor + 8 <= fieldEnd) {
        entry.localHeaderOffset = Number(extra.readBigUInt64LE(cursor));
      }
    }
    offset = fieldEnd;
  }
};

/** Parse one central directory buffer into entries. Pure — unit tested. */
export const parseCentralDirectory = (cd: Buffer): ZipEntry[] => {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + CENTRAL_DIRECTORY_ENTRY_SIZE <= cd.length) {
    if (cd.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      break;
    }
    const nameLength = cd.readUInt16LE(offset + 28);
    const extraLength = cd.readUInt16LE(offset + 30);
    const commentLength = cd.readUInt16LE(offset + 32);
    const entryEnd = offset + CENTRAL_DIRECTORY_ENTRY_SIZE + nameLength + extraLength + commentLength;
    if (entryEnd > cd.length) {
      break;
    }

    const entry: Omit<ZipEntry, 'name' | 'isDirectory'> = {
      flags: cd.readUInt16LE(offset + 8),
      compressionMethod: cd.readUInt16LE(offset + 10),
      crc32: cd.readUInt32LE(offset + 16),
      compressedSize: cd.readUInt32LE(offset + 20),
      uncompressedSize: cd.readUInt32LE(offset + 24),
      localHeaderOffset: cd.readUInt32LE(offset + 42),
    };
    const extra = cd.subarray(offset + CENTRAL_DIRECTORY_ENTRY_SIZE + nameLength, entryEnd - commentLength);
    parseZip64ExtraFields(extra, entry);

    const name = cd.subarray(offset + CENTRAL_DIRECTORY_ENTRY_SIZE, offset + CENTRAL_DIRECTORY_ENTRY_SIZE + nameLength);
    entries.push({
      ...entry,
      name: name.toString('utf8'),
      isDirectory: name.length > 0 && name[name.length - 1] === 0x2f,
    });

    offset = entryEnd;
  }
  return entries;
};

/** Read the zip's central directory (incl. zip64) from disk. */
export const readZipEntries = async (zipPath: string): Promise<ZipEntry[]> => {
  const stats = await fsp.stat(zipPath);
  const tailLength = Math.min(stats.size, MAX_ZIP_TAIL_SIZE);
  const handle = await fsp.open(zipPath, 'r');
  try {
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, stats.size - tailLength);

    const eocd = parseEndOfCentralDirectory(tail, stats.size);
    if (!eocd) {
      throw corruptZip('no end-of-central-directory record found');
    }

    let { entryCount, cdSize, cdOffset } = eocd;
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      if (eocd.eocdOffset < 20) {
        throw corruptZip('zip64 placeholders without room for a zip64 locator');
      }
      const locator = Buffer.alloc(20);
      await handle.read(locator, 0, 20, eocd.eocdOffset - 20);
      const zip64EocdOffset = Number(locator.readBigUInt64LE(8));
      const zip64Eocd = Buffer.alloc(56);
      await handle.read(zip64Eocd, 0, 56, zip64EocdOffset);
      const zip64 = parseZip64Tail(locator, zip64Eocd);
      if (!zip64) {
        throw corruptZip('zip64 placeholders without a zip64 end-of-central-directory record');
      }
      ({ entryCount, cdSize, cdOffset } = zip64);
    }

    if (cdOffset + cdSize > stats.size) {
      throw corruptZip('central directory extends past the end of the file');
    }

    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);

    const entries = parseCentralDirectory(cd);
    if (entries.length < entryCount) {
      throw corruptZip(`central directory holds ${entries.length} of ${entryCount} entries`);
    }
    return entries;
  } finally {
    await handle.close();
  }
};

/**
 * The uncompressed image entry to inject the config into: the largest `.img` file
 * in the archive (mirror zips carry exactly one). An archive without an `.img` entry
 * is only accepted when it holds exactly one file (unambiguous); otherwise it is
 * refused rather than injecting a config into a sidecar file.
 * Pure — unit tested.
 */
export const pickImageEntry = (entries: ZipEntry[]): ZipEntry => {
  const candidates = entries.filter((entry) => !entry.isDirectory);
  const images = candidates.filter((entry) => entry.name.toLowerCase().endsWith('.img'));

  if (images.length > 0) {
    return images.reduce((largest, entry) => (entry.uncompressedSize > largest.uncompressedSize ? entry : largest));
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  throw corruptZip('the archive contains no image entry');
};

/** Byte offset of an entry's compressed data (past its local file header). */
const zipEntryDataStart = async (zipPath: string, entry: ZipEntry): Promise<number> => {
  const handle = await fsp.open(zipPath, 'r');
  try {
    const header = Buffer.alloc(LOCAL_FILE_HEADER_SIZE);
    const { bytesRead } = await handle.read(header, 0, LOCAL_FILE_HEADER_SIZE, entry.localHeaderOffset);
    if (bytesRead < LOCAL_FILE_HEADER_SIZE || header.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw corruptZip(`missing local file header for '${entry.name}'`);
    }
    return entry.localHeaderOffset + LOCAL_FILE_HEADER_SIZE + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
};

/**
 * Stream a single entry out of the zip into `destination`, verifying the
 * entry's CRC-32 and uncompressed size (integrity on top of the archive-level
 * sha256 verification done at download time).
 */
export const extractZipEntry = async (zipPath: string, entry: ZipEntry, destination: string): Promise<void> => {
  if (entry.flags & 0x1) {
    throw corruptZip(`entry '${entry.name}' is encrypted`);
  }
  const dataStart = await zipEntryDataStart(zipPath, entry);
  if (dataStart + entry.compressedSize > (await fsp.stat(zipPath)).size) {
    throw corruptZip(`entry '${entry.name}' data extends past the end of the file`);
  }

  let writtenBytes = 0;
  let crc = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      writtenBytes += chunk.length;
      // Oversize-inflation guard: a corrupted or malicious deflate stream must not be
      // able to inflate past the directory-declared size and fill the disk.
      if (writtenBytes > entry.uncompressedSize) {
        callback(
          corruptZip(`entry '${entry.name}' inflated past its declared size of ${entry.uncompressedSize} bytes`),
        );
        return;
      }
      crc = zlib.crc32(chunk, crc);
      callback(null, chunk);
    },
  });

  const input = createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  const output = createWriteStream(destination);

  if (entry.compressionMethod === COMPRESSION_METHOD_STORED) {
    await streamPipeline(input, verifier, output);
  } else if (entry.compressionMethod === COMPRESSION_METHOD_DEFLATE) {
    const inflate = zlib.createInflateRaw();
    await streamPipeline(input, inflate, verifier, output);
  } else {
    throw corruptZip(`entry '${entry.name}' uses unsupported compression method ${entry.compressionMethod}`);
  }

  if (writtenBytes !== entry.uncompressedSize) {
    throw corruptZip(
      `entry '${entry.name}' inflated to ${writtenBytes} bytes but the directory says ${entry.uncompressedSize}`,
    );
  }
  if (crc !== entry.crc32) {
    throw corruptZip(`entry '${entry.name}' failed its CRC-32 check`);
  }
};

export interface ReviewZipEntry {
  path: string;
  content: string | Buffer;
}

interface PreparedZipEntry {
  path: string;
  content: Buffer;
  crc32: number;
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CRC32_TABLE = createCrc32Table();

export function createUncompressedZip(entries: ReviewZipEntry[]): Buffer {
  const preparedEntries = prepareEntries(entries);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of preparedEntries) {
    const name = Buffer.from(entry.path, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(entry.crc32 >>> 0, 14);
    localHeader.writeUInt32LE(entry.content.byteLength, 18);
    localHeader.writeUInt32LE(entry.content.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, entry.content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(entry.crc32 >>> 0, 16);
    centralHeader.writeUInt32LE(entry.content.byteLength, 20);
    centralHeader.writeUInt32LE(entry.content.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.byteLength + name.byteLength + entry.content.byteLength;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(preparedEntries.length, 8);
  end.writeUInt16LE(preparedEntries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readUncompressedZipEntries(zip: Buffer): Array<{ path: string; content: Buffer }> {
  const entries: Array<{ path: string; content: Buffer }> = [];
  const seen = new Set<string>();
  let offset = 0;

  while (offset + 4 <= zip.byteLength && zip.readUInt32LE(offset) === LOCAL_FILE_HEADER_SIGNATURE) {
    const compressionMethod = zip.readUInt16LE(offset + 8);
    if (compressionMethod !== 0) {
      throw new Error('Unsupported ZIP compression method');
    }

    const compressedSize = zip.readUInt32LE(offset + 18);
    const fileNameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const contentStart = nameEnd + extraLength;
    const contentEnd = contentStart + compressedSize;
    if (contentEnd > zip.byteLength) {
      throw new Error('Invalid ZIP entry size');
    }

    const path = normalizeEntryPath(zip.subarray(nameStart, nameEnd).toString('utf8'));
    if (seen.has(path)) {
      throw new Error(`Duplicate ZIP entry path: ${path}`);
    }
    seen.add(path);
    entries.push({ path, content: Buffer.from(zip.subarray(contentStart, contentEnd)) });
    offset = contentEnd;
  }

  return entries;
}

export function appendZipEntries(zip: Buffer, entries: ReviewZipEntry[]): Buffer {
  const existing = readUncompressedZipEntries(zip).map((entry) => ({
    path: entry.path,
    content: entry.content,
  }));
  return createUncompressedZip([...existing, ...entries]);
}

export function listZipEntryNames(zip: Buffer): string[] {
  return readUncompressedZipEntries(zip).map((entry) => entry.path);
}

function prepareEntries(entries: ReviewZipEntry[]): PreparedZipEntry[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    const path = normalizeEntryPath(entry.path);
    if (seen.has(path)) {
      throw new Error(`Duplicate ZIP entry path: ${path}`);
    }
    seen.add(path);
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    return { path, content, crc32: crc32(content) };
  });
}

function normalizeEntryPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '' || part === '..')
  ) {
    throw new Error(`Unsafe ZIP entry path: ${value}`);
  }
  return value;
}

function createCrc32Table(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table.push(value >>> 0);
  }
  return table;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

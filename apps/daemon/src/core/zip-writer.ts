export interface ZipEntry {
  path: string;
  content: string | Buffer;
  modifiedAt?: Date;
}

interface PreparedEntry {
  path: string;
  content: Buffer;
  crc32: number;
  modifiedAt: Date;
  localHeaderOffset: number;
}

const localFileHeaderSignature = 0x04034b50;
const centralDirectoryHeaderSignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;

export function createZipBuffer(entries: ZipEntry[]): Buffer {
  const prepared = entries
    .map((entry) => prepareEntry(entry))
    .sort((left, right) => left.path.localeCompare(right.path));
  const localParts: Buffer[] = [];
  let offset = 0;

  for (const entry of prepared) {
    entry.localHeaderOffset = offset;
    const localHeader = createLocalFileHeader(entry);
    localParts.push(localHeader, entry.content);
    offset += localHeader.byteLength + entry.content.byteLength;
  }

  const centralDirectoryOffset = offset;
  const centralParts = prepared.map((entry) => createCentralDirectoryHeader(entry));
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = createEndOfCentralDirectory({
    entryCount: prepared.length,
    centralDirectoryOffset,
    centralDirectorySize,
  });

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function prepareEntry(entry: ZipEntry): PreparedEntry {
  assertSafeZipPath(entry.path);
  const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
  return {
    path: entry.path,
    content,
    crc32: crc32(content),
    modifiedAt: entry.modifiedAt ?? new Date(Date.UTC(1980, 0, 1)),
    localHeaderOffset: 0,
  };
}

function assertSafeZipPath(entryPath: string): void {
  const parts = entryPath.split('/');
  if (
    entryPath.length === 0 ||
    entryPath.startsWith('/') ||
    entryPath.includes('\\') ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`BAD_ZIP_ENTRY_PATH: ${entryPath}`);
  }
}

function createLocalFileHeader(entry: PreparedEntry): Buffer {
  const name = Buffer.from(entry.path, 'utf8');
  const header = Buffer.alloc(30);
  const { dosDate, dosTime } = toDosDateTime(entry.modifiedAt);
  header.writeUInt32LE(localFileHeaderSignature, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(entry.crc32, 14);
  header.writeUInt32LE(entry.content.byteLength, 18);
  header.writeUInt32LE(entry.content.byteLength, 22);
  header.writeUInt16LE(name.byteLength, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}

function createCentralDirectoryHeader(entry: PreparedEntry): Buffer {
  const name = Buffer.from(entry.path, 'utf8');
  const header = Buffer.alloc(46);
  const { dosDate, dosTime } = toDosDateTime(entry.modifiedAt);
  header.writeUInt32LE(centralDirectoryHeaderSignature, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(dosTime, 12);
  header.writeUInt16LE(dosDate, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.content.byteLength, 20);
  header.writeUInt32LE(entry.content.byteLength, 24);
  header.writeUInt16LE(name.byteLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.localHeaderOffset, 42);
  return Buffer.concat([header, name]);
}

function createEndOfCentralDirectory(input: {
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
}): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(endOfCentralDirectorySignature, 0);
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(input.entryCount, 8);
  header.writeUInt16LE(input.entryCount, 10);
  header.writeUInt32LE(input.centralDirectorySize, 12);
  header.writeUInt32LE(input.centralDirectoryOffset, 16);
  header.writeUInt16LE(0, 20);
  return header;
}

function toDosDateTime(date: Date): { dosDate: number; dosTime: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = Math.floor(date.getUTCSeconds() / 2);
  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hour << 11) | (minute << 5) | second,
  };
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

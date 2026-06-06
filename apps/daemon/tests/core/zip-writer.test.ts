import { describe, expect, it } from 'vitest';
import { createZipBuffer } from '../../src/core/zip-writer.js';

describe('zip writer', () => {
  it('creates a deterministic uncompressed zip buffer', () => {
    const buffer = createZipBuffer([
      { path: 'manifest.json', content: '{"ok":true}' },
      { path: 'logs/stdout.log', content: 'hello' },
    ]);

    expect([...buffer.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(readStoredEntries(buffer)).toEqual({
      'logs/stdout.log': 'hello',
      'manifest.json': '{"ok":true}',
    });
  });

  it('rejects unsafe zip entry paths', () => {
    expect(() => createZipBuffer([{ path: '../escape.txt', content: 'x' }])).toThrow(/BAD_ZIP_ENTRY_PATH/);
    expect(() => createZipBuffer([{ path: '/absolute.txt', content: 'x' }])).toThrow(/BAD_ZIP_ENTRY_PATH/);
    expect(() => createZipBuffer([{ path: 'bad\\path.txt', content: 'x' }])).toThrow(/BAD_ZIP_ENTRY_PATH/);
  });
});

function readStoredEntries(buffer: Buffer): Record<string, string> {
  const entries: Record<string, string> = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
    const contentStart = nameStart + fileNameLength + extraLength;
    entries[name] = buffer.subarray(contentStart, contentStart + compressedSize).toString('utf8');
    offset = contentStart + compressedSize;
  }
  expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
  return entries;
}

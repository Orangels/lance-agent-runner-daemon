import { describe, expect, it } from 'vitest';
import {
  appendZipEntries,
  createUncompressedZip,
  listZipEntryNames,
  readUncompressedZipEntries,
} from '../../../src/server/zip/uncompressed-zip.js';

describe('RPA review ZIP helpers', () => {
  it('creates and reads uncompressed ZIP entries', () => {
    const zip = createUncompressedZip([
      { path: 'manifest.json', content: '{"ok":true}\n' },
      { path: 'extensions/rpa/rpa-summary.md', content: '# Summary\n' },
    ]);

    expect(zip.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(listZipEntryNames(zip)).toEqual(['manifest.json', 'extensions/rpa/rpa-summary.md']);
    expect(
      Object.fromEntries(
        readUncompressedZipEntries(zip).map((entry) => [entry.path, entry.content.toString('utf8')]),
      ),
    ).toEqual({
      'manifest.json': '{"ok":true}\n',
      'extensions/rpa/rpa-summary.md': '# Summary\n',
    });
  });

  it('appends RPA extension entries without modifying existing daemon entries', () => {
    const daemonZip = createUncompressedZip([{ path: 'review-summary.md', content: 'daemon\n' }]);
    const combined = appendZipEntries(daemonZip, [
      { path: 'extensions/rpa/rpa-summary.md', content: 'rpa\n' },
    ]);

    expect(
      Object.keys(
        Object.fromEntries(readUncompressedZipEntries(combined).map((entry) => [entry.path, true])),
      ),
    ).toEqual(['review-summary.md', 'extensions/rpa/rpa-summary.md']);
  });

  it('rejects unsafe ZIP paths', () => {
    expect(() => createUncompressedZip([{ path: '../secret.txt', content: 'x' }])).toThrow(/unsafe/i);
    expect(() => createUncompressedZip([{ path: '/secret.txt', content: 'x' }])).toThrow(/unsafe/i);
    expect(() => createUncompressedZip([{ path: 'extensions\\rpa\\x', content: 'x' }])).toThrow(/unsafe/i);
  });
});

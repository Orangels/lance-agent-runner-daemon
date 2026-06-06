import { describe, expect, it } from 'vitest';
import { buildContentDisposition } from '../../src/http/http-utils.js';

describe('http utilities', () => {
  it('builds content disposition with a safe ASCII fallback and encoded UTF-8 filename', () => {
    const header = buildContentDisposition('报告"; filename="evil.zip');

    expect(header).toContain('attachment; filename="filename_evil.zip"');
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain('%E6%8A%A5%E5%91%8A%22%3B%20filename%3D%22evil.zip');
    expect(header).not.toContain('filename="报告');
  });
});

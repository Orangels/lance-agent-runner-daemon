import { describe, expect, it } from 'vitest';
import { sanitizeLogText } from '../../src/core/log-sanitizer.js';

describe('log sanitizer', () => {
  it('redacts Claude config directory values', () => {
    expect(sanitizeLogText('CLAUDE_CONFIG_DIR=/home/user/.claude')).toBe('[redacted]');
  });

  it('redacts bearer, cookie, token, and api key values', () => {
    const input = [
      'authorization: Bearer secret-bearer',
      'cookie=session=secret-cookie',
      'token=my-token',
      'api_key=sk-local-secret',
      'api-key: another-secret',
    ].join('\n');

    const output = sanitizeLogText(input);

    expect(output).not.toContain('secret-bearer');
    expect(output).not.toContain('secret-cookie');
    expect(output).not.toContain('my-token');
    expect(output).not.toContain('sk-local-secret');
    expect(output).not.toContain('another-secret');
    expect(output.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('redacts Anthropic API keys', () => {
    expect(sanitizeLogText('key=sk-ant-api03-secret_value')).not.toContain('sk-ant-api03-secret_value');
  });

  it('redacts absolute POSIX paths', () => {
    expect(sanitizeLogText('failed to read /home/orangels/project/secret.txt')).toBe(
      'failed to read [redacted-path]',
    );
  });

  it('preserves ordinary relative paths', () => {
    expect(sanitizeLogText('wrote output/report.docx and ./work/draft.md')).toBe(
      'wrote output/report.docx and ./work/draft.md',
    );
  });
});

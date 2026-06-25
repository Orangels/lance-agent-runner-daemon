import { describe, expect, it } from 'vitest';
import { sanitizeLogText, sanitizeReviewValue } from '../../src/core/log-sanitizer.js';

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

  it('redacts password, secret, private key, and storage state values in log text', () => {
    const output = sanitizeLogText(
      'password=hunter2 secret=hidden private_key=abc storage_state=/tmp/state.json output/report.docx',
    );

    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('hidden');
    expect(output).not.toContain('private_key=abc');
    expect(output).not.toContain('/tmp/state.json');
    expect(output).toContain('output/report.docx');
  });

  it('redacts sensitive object values for review bundle JSON', () => {
    expect(
      sanitizeReviewValue({
        password: 'secret',
        nested: { token: 'abc' },
        path: '/home/orangels/project/file.txt',
        artifactPath: 'output/report.docx',
      }),
    ).toEqual({
      password: '[redacted]',
      nested: { token: '[redacted]' },
      path: '[redacted-path]',
      artifactPath: 'output/report.docx',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { probeClaudeCapabilities } from '../claude-capabilities.js';

describe('probeClaudeCapabilities', () => {
  it('parses claude -p --help output for supported flags', async () => {
    const capabilities = await probeClaudeCapabilities({
      claudeBin: 'claude',
      execFile: (file, args, callback) => {
        expect(file).toBe('claude');
        expect(args).toEqual(['-p', '--help']);
        callback(null, 'Usage\n  --include-partial-messages\n  --add-dir <path>\n', '');
      },
    });

    expect(capabilities).toEqual({
      partialMessages: true,
      addDir: true,
    });
  });

  it('marks probed flags unsupported when help omits them', async () => {
    const capabilities = await probeClaudeCapabilities({
      claudeBin: 'claude',
      execFile: (_file, _args, callback) => {
        callback(null, 'Usage\n  --model <model>\n', '');
      },
    });

    expect(capabilities).toEqual({
      partialMessages: false,
      addDir: false,
    });
  });
});

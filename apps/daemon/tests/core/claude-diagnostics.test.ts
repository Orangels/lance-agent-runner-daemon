import { describe, expect, it } from 'vitest';
import { diagnoseClaudeCliFailure } from '../../src/core/claude-diagnostics.js';

describe('diagnoseClaudeCliFailure', () => {
  it('classifies authentication failures as CLAUDE_AUTH_FAILED', () => {
    const diagnostic = diagnoseClaudeCliFailure({
      exitCode: 1,
      stderr: 'Error: 401 unauthorized, invalid API key',
    });

    expect(diagnostic).toEqual({
      code: 'CLAUDE_AUTH_FAILED',
      message: 'Claude CLI authentication failed.',
      details: { category: 'auth' },
    });
  });

  it('classifies model access failures as CLAUDE_CLI_FAILED', () => {
    const diagnostic = diagnoseClaudeCliFailure({
      exitCode: 1,
      stderr: 'Selected model is not available for your account.',
    });

    expect(diagnostic).toEqual({
      code: 'CLAUDE_CLI_FAILED',
      message: 'Claude CLI failed.',
      details: { category: 'model' },
    });
  });

  it('classifies configuration failures as CLAUDE_CLI_FAILED', () => {
    const diagnostic = diagnoseClaudeCliFailure({
      exitCode: 1,
      stderr: 'Claude config is corrupt or missing required profile state.',
    });

    expect(diagnostic).toEqual({
      code: 'CLAUDE_CLI_FAILED',
      message: 'Claude CLI failed.',
      details: { category: 'config' },
    });
  });

  it('classifies spawn failures as CLAUDE_CLI_FAILED', () => {
    const diagnostic = diagnoseClaudeCliFailure({
      spawnError: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
    });

    expect(diagnostic).toEqual({
      code: 'CLAUDE_CLI_FAILED',
      message: 'Claude CLI failed.',
      details: { category: 'spawn' },
    });
  });

  it('classifies non-zero exits without known output as CLAUDE_CLI_FAILED', () => {
    const diagnostic = diagnoseClaudeCliFailure({
      exitCode: 2,
      stderr: 'unexpected failure',
    });

    expect(diagnostic).toEqual({
      code: 'CLAUDE_CLI_FAILED',
      message: 'Claude CLI failed.',
      details: { category: 'unknown' },
    });
  });

  it('returns null for successful exits', () => {
    expect(
      diagnoseClaudeCliFailure({
        exitCode: 0,
        stdout: 'done',
      }),
    ).toBeNull();
  });

  it('redacts sensitive and local path data from machine-readable details', () => {
    const diagnostic = diagnoseClaudeCliFailure({
      exitCode: 1,
      stderr:
        '401 bearer sk-ant-api03-secret token=secret cookie=session path=/home/orangels/.claude',
      stdout: 'CLAUDE_CONFIG_DIR=/home/orangels/.claude',
      claudeConfigDir: '/home/orangels/.claude',
    });
    const serialized = JSON.stringify(diagnostic);

    expect(serialized).not.toContain('sk-ant-api03-secret');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('session');
    expect(serialized).not.toContain('CLAUDE_CONFIG_DIR');
    expect(serialized).not.toContain('/home/orangels');
    expect(serialized).not.toContain('bearer');
    expect(serialized).not.toContain('cookie');
    expect(serialized).not.toContain('token');
  });

  it('does not include product-specific guidance or environment names', () => {
    const diagnostic = diagnoseClaudeCliFailure({
      exitCode: 1,
      stderr: '401 unauthorized',
    });
    const serialized = JSON.stringify(diagnostic).toLowerCase();

    expect(serialized).not.toContain('lancedesign');
    expect(serialized).not.toContain('lancerouter');
    expect(serialized).not.toContain('open settings');
    expect(serialized).not.toContain('settings dialog');
    expect(serialized).not.toContain('lance_design_');
  });
});

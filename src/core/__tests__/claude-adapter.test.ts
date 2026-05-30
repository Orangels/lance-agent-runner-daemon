import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProfileConfig } from '../../config/profiles.js';
import { DaemonError } from '../errors.js';
import { buildClaudeInvocation } from '../claude-adapter.js';

function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    id: 'default',
    sandboxRoot: '/tmp/runner/sandboxes',
    claudeConfigDir: '/tmp/runner/profiles/default/claude',
    claudeBin: 'claude',
    skillRoots: [],
    allowedInputRoots: [],
    allowedSkillIds: [],
    artifactRules: [],
    defaultArtifactRuleIds: [],
    permissionMode: 'bypassPermissions',
    defaultModel: 'sonnet',
    allowedModels: ['sonnet', 'opus'],
    eventVisibility: 'normal',
    profileConcurrency: 1,
    runTimeoutMs: 60_000,
    inactivityTimeoutMs: 10_000,
    cancelGraceMs: 1_000,
    env: {},
    ...overrides,
  };
}

describe('buildClaudeInvocation', () => {
  it('builds the baseline stream-json argv', () => {
    const invocation = buildClaudeInvocation({
      profile: makeProfile(),
      prompt: 'Revise the document.',
      workspaceCwd: '/tmp/runner/sandboxes/workspace/work',
    });

    expect(invocation.args.slice(0, 4)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
  });

  it('only includes partial messages when the capability probe supports it', () => {
    expect(
      buildClaudeInvocation({
        profile: makeProfile(),
        prompt: 'hello',
        workspaceCwd: '/tmp/work',
        capabilities: { partialMessages: true },
      }).args,
    ).toContain('--include-partial-messages');

    expect(
      buildClaudeInvocation({
        profile: makeProfile(),
        prompt: 'hello',
        workspaceCwd: '/tmp/work',
        capabilities: { partialMessages: false },
      }).args,
    ).not.toContain('--include-partial-messages');

    expect(
      buildClaudeInvocation({
        profile: makeProfile(),
        prompt: 'hello',
        workspaceCwd: '/tmp/work',
      }).args,
    ).not.toContain('--include-partial-messages');
  });

  it('adds only explicit extra dirs when add-dir support is true or unknown', () => {
    const workspaceCwd = path.join('/tmp', 'runner', 'workspace', 'work');
    const stagedSkillDir = path.join(workspaceCwd, '.claude-runner-skills', 'report-writer');

    for (const capabilities of [{ addDir: true }, undefined]) {
      const invocation = buildClaudeInvocation({
        profile: makeProfile(),
        prompt: 'hello',
        workspaceCwd,
        extraAllowedDirs: [stagedSkillDir],
        capabilities,
      });

      const addDirIndex = invocation.args.indexOf('--add-dir');
      expect(addDirIndex).toBeGreaterThan(-1);
      expect(invocation.args.slice(addDirIndex, addDirIndex + 2)).toEqual([
        '--add-dir',
        stagedSkillDir,
      ]);
      expect(invocation.args).not.toContain(workspaceCwd);
    }
  });

  it('omits add-dir when explicitly unsupported', () => {
    const invocation = buildClaudeInvocation({
      profile: makeProfile(),
      prompt: 'hello',
      workspaceCwd: '/tmp/work',
      extraAllowedDirs: ['/tmp/uploads'],
      capabilities: { addDir: false },
    });

    expect(invocation.args).not.toContain('--add-dir');
  });

  it('uses an allowed request model instead of the default model', () => {
    const invocation = buildClaudeInvocation({
      profile: makeProfile(),
      prompt: 'hello',
      workspaceCwd: '/tmp/work',
      requestModel: 'opus',
    });

    expect(invocation.args).toEqual(expect.arrayContaining(['--model', 'opus']));
    expect(invocation.args).not.toEqual(expect.arrayContaining(['--model', 'sonnet']));
  });

  it('uses the profile default model when no request model is provided', () => {
    const invocation = buildClaudeInvocation({
      profile: makeProfile(),
      prompt: 'hello',
      workspaceCwd: '/tmp/work',
    });

    expect(invocation.args).toEqual(expect.arrayContaining(['--model', 'sonnet']));
  });

  it('raises MODEL_NOT_ALLOWED for disallowed request models', () => {
    expect(() =>
      buildClaudeInvocation({
        profile: makeProfile(),
        prompt: 'hello',
        workspaceCwd: '/tmp/work',
        requestModel: 'haiku',
      }),
    ).toThrow(DaemonError);

    try {
      buildClaudeInvocation({
        profile: makeProfile(),
        prompt: 'hello',
        workspaceCwd: '/tmp/work',
        requestModel: 'haiku',
      });
    } catch (error) {
      expect((error as DaemonError).code).toBe('MODEL_NOT_ALLOWED');
      expect((error as DaemonError).status).toBe(400);
    }
  });

  it('uses the profile permission mode', () => {
    const invocation = buildClaudeInvocation({
      profile: makeProfile({ permissionMode: 'acceptEdits' }),
      prompt: 'hello',
      workspaceCwd: '/tmp/work',
    });

    expect(invocation.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
  });

  it('sets CLAUDE_CONFIG_DIR and allowlisted profile env', () => {
    const invocation = buildClaudeInvocation({
      profile: makeProfile({
        claudeConfigDir: '/tmp/custom-claude',
        env: {
          ANTHROPIC_BASE_URL: 'https://anthropic.example',
          DISABLE_TELEMETRY: '1',
        },
      }),
      prompt: 'hello',
      workspaceCwd: '/tmp/work',
      baseEnv: {},
    });

    expect(invocation.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://anthropic.example',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CONFIG_DIR: '/tmp/custom-claude',
    });
  });

  it('inherits base env while filtering lanceDesign product env', () => {
    const invocation = buildClaudeInvocation({
      profile: makeProfile({
        claudeConfigDir: '/tmp/custom-claude',
        env: {
          DISABLE_TELEMETRY: '1',
        },
      }),
      prompt: 'hello',
      workspaceCwd: '/tmp/work',
      baseEnv: {
        PATH: '/usr/bin',
        LANG: 'C.UTF-8',
        LANCE_DESIGN_BIN: '/tmp/lancedesign',
        LANCE_DESIGN_DAEMON_URL: 'http://127.0.0.1:3000',
      },
    });

    expect(invocation.env).toEqual({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CONFIG_DIR: '/tmp/custom-claude',
    });
  });

  it('keeps prompt separate from argv', () => {
    const prompt = 'This prompt must be stdin-only.';
    const invocation = buildClaudeInvocation({
      profile: makeProfile(),
      prompt,
      workspaceCwd: '/tmp/work',
    });

    expect(invocation.stdinPrompt).toBe(prompt);
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.args.join('\0')).not.toContain(prompt);
  });
});

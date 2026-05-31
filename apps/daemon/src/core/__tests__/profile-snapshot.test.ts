import { describe, expect, it } from 'vitest';
import type { ProfileConfig } from '../../config/profiles.js';
import { createSanitizedProfileSnapshot } from '../profile-snapshot.js';

function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    id: 'default',
    sandboxRoot: '/tmp/runner/sandboxes',
    claudeConfigDir: '/tmp/runner/profiles/default/claude',
    claudeBin: '/usr/local/bin/claude',
    skillRoots: ['/tmp/runner/skills'],
    allowedInputRoots: ['/tmp/uploads'],
    allowedSkillIds: ['revise-doc'],
    artifactRules: [{ id: 'report', pattern: 'output/report.docx', role: 'primary', required: true }],
    defaultArtifactRuleIds: ['report'],
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

describe('createSanitizedProfileSnapshot', () => {
  it('captures stable non-secret profile settings', () => {
    expect(createSanitizedProfileSnapshot(makeProfile())).toMatchObject({
      version: 1,
      profileId: 'default',
      allowedSkillIds: ['revise-doc'],
      artifactRules: [{ id: 'report', pattern: 'output/report.docx', role: 'primary', required: true }],
      defaultArtifactRuleIds: ['report'],
      permissionMode: 'bypassPermissions',
      defaultModel: 'sonnet',
      allowedModels: ['sonnet', 'opus'],
      eventVisibility: 'normal',
      profileConcurrency: 1,
      runTimeoutMs: 60_000,
      inactivityTimeoutMs: 10_000,
      cancelGraceMs: 1_000,
      envKeys: [],
      directoryCounts: { skillRoots: 1, allowedInputRoots: 1 },
    });
  });

  it('stores env key names only and omits path and secret values', () => {
    const snapshot = createSanitizedProfileSnapshot(
      makeProfile({
        sandboxRoot: '/secret/sandbox/root',
        claudeConfigDir: '/secret/claude/config',
        skillRoots: ['/secret/skills'],
        allowedInputRoots: ['/secret/uploads'],
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-secret-token',
          ANTHROPIC_BASE_URL: 'https://private-anthropic.example',
          DISABLE_TELEMETRY: 'cookie=secret; Authorization: Bearer token-value',
        },
      }),
    );

    expect(snapshot.envKeys).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'DISABLE_TELEMETRY']);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain('ANTHROPIC_API_KEY');
    expect(serialized).not.toContain('sk-ant-secret-token');
    expect(serialized).not.toContain('https://private-anthropic.example');
    expect(serialized).not.toContain('cookie=secret');
    expect(serialized).not.toContain('Bearer token-value');
    expect(serialized).not.toContain('/secret/claude/config');
    expect(serialized).not.toContain('/secret/sandbox/root');
    expect(serialized).not.toContain('/secret/skills');
    expect(serialized).not.toContain('/secret/uploads');
    expect(serialized).not.toContain('/usr/local/bin/claude');
  });
});

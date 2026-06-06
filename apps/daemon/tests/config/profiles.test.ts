import { describe, expect, it } from 'vitest';
import {
  getArtifactRule,
  getProfile,
  isModelAllowed,
  parseDaemonConfig,
} from '../../src/config/profiles.js';

const validConfig = {
  server: {
    host: '127.0.0.1',
    port: 17890,
    dataDir: '/tmp/claude-runner-test/data',
    globalConcurrency: 4,
    maxQueueSize: 100,
  },
  clients: [
    {
      id: 'lqbot',
      apiKey: 'env:CLAUDE_RUNNER_TEST_KEY',
      allowedProfileIds: ['report-docx'],
      canReadDebugEvents: false,
      canReadLogs: true,
    },
  ],
  profiles: [
    {
      id: 'report-docx',
      sandboxRoot: '/tmp/claude-runner-test/sandboxes',
      claudeConfigDir: '/tmp/claude-runner-test/profiles/report-docx/claude',
      claudeBin: 'claude',
      skillRoots: ['/tmp/claude-runner-test/skills/common'],
      allowedInputRoots: ['/tmp/claude-runner-test/uploads'],
      allowedSkillIds: ['report-writer'],
      artifactRules: [
        {
          id: 'report-docx',
          pattern: 'output/**/*.docx',
          role: 'primary',
          required: true,
        },
      ],
      defaultArtifactRuleIds: ['report-docx'],
      permissionMode: 'bypassPermissions',
      defaultModel: 'sonnet',
      allowedModels: ['sonnet', 'opus'],
      eventVisibility: 'quiet',
      profileConcurrency: 2,
      runTimeoutMs: 1_800_000,
      inactivityTimeoutMs: 600_000,
      cancelGraceMs: 3_000,
      env: {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        DISABLE_TELEMETRY: '1',
      },
    },
  ],
};

describe('daemon config parsing', () => {
  it('accepts a minimal valid config with one client and one profile', () => {
    const config = parseDaemonConfig(validConfig, {
      env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' },
    });

    expect(config.server.port).toBe(17890);
    expect(config.server.logRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(config.server.maxLogBytesPerRun).toBe(4 * 1024 * 1024);
    expect(config.server.maxUploadBytesPerFile).toBe(50 * 1024 * 1024);
    expect(config.server.uploadTempRetentionMs).toBe(24 * 60 * 60 * 1000);
    expect(config.clients[0]?.apiKey).toBe('secret-key');
    expect(config.profiles[0]?.id).toBe('report-docx');
    expect(config.profiles[0]?.maxCollectionMode).toBe('lite');
  });

  it('accepts explicit max collection modes', () => {
    for (const maxCollectionMode of ['diagnostic', 'review'] as const) {
      const config = parseDaemonConfig(
        {
          ...validConfig,
          profiles: [
            {
              ...validConfig.profiles[0],
              maxCollectionMode,
            },
          ],
        },
        { env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' } },
      );

      expect(config.profiles[0]?.maxCollectionMode).toBe(maxCollectionMode);
    }
  });

  it('accepts explicit log retention and per-run log byte caps', () => {
    const config = parseDaemonConfig(
      {
        ...validConfig,
        server: {
          ...validConfig.server,
          logRetentionMs: 3_600_000,
          maxLogBytesPerRun: 1024,
        },
      },
      { env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' } },
    );

    expect(config.server.logRetentionMs).toBe(3_600_000);
    expect(config.server.maxLogBytesPerRun).toBe(1024);
  });

  it('accepts explicit upload limits and temp retention', () => {
    const config = parseDaemonConfig(
      {
        ...validConfig,
        server: {
          ...validConfig.server,
          maxUploadBytesPerFile: 4096,
          uploadTempRetentionMs: 60_000,
        },
      },
      { env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' } },
    );

    expect(config.server.maxUploadBytesPerFile).toBe(4096);
    expect(config.server.uploadTempRetentionMs).toBe(60_000);
  });

  it('rejects invalid upload limits and temp retention', () => {
    expect(() =>
      parseDaemonConfig(
        {
          ...validConfig,
          server: {
            ...validConfig.server,
            maxUploadBytesPerFile: 0,
          },
        },
        { env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' } },
      ),
    ).toThrow(/maxUploadBytesPerFile/);

    expect(() =>
      parseDaemonConfig(
        {
          ...validConfig,
          server: {
            ...validConfig.server,
            uploadTempRetentionMs: -1,
          },
        },
        { env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' } },
      ),
    ).toThrow(/uploadTempRetentionMs/);
  });

  it('resolves client apiKey values from env references', () => {
    const config = parseDaemonConfig(validConfig, {
      env: { CLAUDE_RUNNER_TEST_KEY: 'resolved-secret' },
    });

    expect(config.clients[0]?.apiKey).toBe('resolved-secret');
  });

  it('rejects missing env references for client api keys', () => {
    expect(() => parseDaemonConfig(validConfig, { env: {} })).toThrow(/CLAUDE_RUNNER_TEST_KEY/);
  });

  it('rejects profile env keys outside the allowlist', () => {
    expect(() =>
      parseDaemonConfig(
        {
          ...validConfig,
          profiles: [
            {
              ...validConfig.profiles[0],
              env: {
                NODE_OPTIONS: '--inspect',
              },
            },
          ],
        },
        { env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' } },
      ),
    ).toThrow(/NODE_OPTIONS/);
  });

  it('rejects CLAUDE_CONFIG_DIR inside profile env', () => {
    expect(() =>
      parseDaemonConfig(
        {
          ...validConfig,
          profiles: [
            {
              ...validConfig.profiles[0],
              env: {
                CLAUDE_CONFIG_DIR: '/tmp/wrong-place',
              },
            },
          ],
        },
        { env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' } },
      ),
    ).toThrow(/CLAUDE_CONFIG_DIR/);
  });

  it('accepts only primary, supporting, or debug artifact roles', () => {
    for (const role of ['primary', 'supporting', 'debug']) {
      expect(() =>
        parseDaemonConfig(
          {
            ...validConfig,
            profiles: [
              {
                ...validConfig.profiles[0],
                artifactRules: [
                  {
                    id: `rule-${role}`,
                    pattern: 'output/**/*',
                    role,
                    required: false,
                  },
                ],
                defaultArtifactRuleIds: [`rule-${role}`],
              },
            ],
          },
          { env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' } },
        ),
      ).not.toThrow();
    }

    expect(() =>
      parseDaemonConfig(
        {
          ...validConfig,
          profiles: [
            {
              ...validConfig.profiles[0],
              artifactRules: [
                {
                  id: 'preview',
                  pattern: 'output/**/*',
                  role: 'preview',
                  required: false,
                },
              ],
              defaultArtifactRuleIds: ['preview'],
            },
          ],
        },
        { env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' } },
      ),
    ).toThrow(/role/);
  });

  it('rejects defaultModel when it is not included in allowedModels', () => {
    expect(() =>
      parseDaemonConfig(
        {
          ...validConfig,
          profiles: [
            {
              ...validConfig.profiles[0],
              defaultModel: 'haiku',
              allowedModels: ['sonnet', 'opus'],
            },
          ],
        },
        { env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' } },
      ),
    ).toThrow(/defaultModel/);
  });
});

describe('profile helpers', () => {
  it('looks up profiles, model access, and artifact rules', () => {
    const config = parseDaemonConfig(validConfig, {
      env: { CLAUDE_RUNNER_TEST_KEY: 'secret-key' },
    });

    const profile = getProfile(config, 'report-docx');

    expect(profile.id).toBe('report-docx');
    expect(isModelAllowed(profile, 'sonnet')).toBe(true);
    expect(isModelAllowed(profile, 'haiku')).toBe(false);
    expect(getArtifactRule(profile, 'report-docx')).toEqual({
      id: 'report-docx',
      pattern: 'output/**/*.docx',
      role: 'primary',
      required: true,
    });
  });
});

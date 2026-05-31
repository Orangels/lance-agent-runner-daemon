import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDaemonConfig } from '../config.js';

describe('loadDaemonConfig', () => {
  it('resolves relative paths from the config file directory', () => {
    const root = path.join(tmpdir(), `daemon-config-${process.pid}-${Date.now()}`);
    const configDir = path.join(root, '.claude-runner');
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.local.json');

    writeFileSync(
      configPath,
      JSON.stringify({
        server: {
          host: '127.0.0.1',
          port: 17890,
          dataDir: 'data',
          globalConcurrency: 1,
          maxQueueSize: 10,
        },
        clients: [
          {
            id: 'lqbot',
            apiKey: 'env:TEST_DAEMON_API_KEY',
            allowedProfileIds: ['report-docx'],
          },
        ],
        profiles: [
          {
            id: 'report-docx',
            sandboxRoot: 'workspaces/report-docx',
            claudeConfigDir: 'profiles/report-docx/claude',
            claudeBin: 'claude',
            skillRoots: ['../apps/daemon/skills'],
            allowedInputRoots: ['uploads'],
            allowedSkillIds: ['report-gen'],
            artifactRules: [],
            defaultArtifactRuleIds: [],
            permissionMode: 'bypassPermissions',
            defaultModel: 'opus',
            allowedModels: ['opus'],
            eventVisibility: 'normal',
            profileConcurrency: 1,
            runTimeoutMs: 600_000,
            inactivityTimeoutMs: 120_000,
            cancelGraceMs: 5_000,
            env: {},
          },
        ],
      }),
    );

    const config = loadDaemonConfig(configPath, { TEST_DAEMON_API_KEY: 'secret' });
    const profile = config.profiles[0];

    expect(config.server.dataDir).toBe(path.join(configDir, 'data'));
    expect(profile.sandboxRoot).toBe(path.join(configDir, 'workspaces/report-docx'));
    expect(profile.claudeConfigDir).toBe(path.join(configDir, 'profiles/report-docx/claude'));
    expect(profile.skillRoots).toEqual([path.join(root, 'apps/daemon/skills')]);
    expect(profile.allowedInputRoots).toEqual([path.join(configDir, 'uploads')]);
    expect(config.clients[0].apiKey).toBe('secret');
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDaemonConfig } from '../config/profiles.js';
import { openRunnerDatabase } from '../db/connection.js';
import { getRunDetail, insertRunQueued, upsertWorkspace } from '../db/repositories.js';
import { applySchema } from '../db/schema.js';
import { createServerContext } from '../index.js';

function makeConfig(root: string) {
  return parseDaemonConfig(
    {
      server: {
        host: '127.0.0.1',
        port: 17890,
        dataDir: path.join(root, 'data'),
        globalConcurrency: 4,
        maxQueueSize: 100,
      },
      clients: [{ id: 'lqbot', apiKey: 'secret', allowedProfileIds: ['report-docx'] }],
      profiles: [
        {
          id: 'report-docx',
          sandboxRoot: path.join(root, 'sandboxes'),
          claudeConfigDir: path.join(root, 'profiles/report-docx/claude'),
          claudeBin: 'claude',
          skillRoots: [path.join(root, 'skills')],
          allowedInputRoots: [path.join(root, 'uploads')],
          allowedSkillIds: ['report-writer'],
          artifactRules: [
            { id: 'report-docx', pattern: 'output/**/*.docx', role: 'primary', required: true },
          ],
          defaultArtifactRuleIds: ['report-docx'],
          permissionMode: 'bypassPermissions',
          defaultModel: 'sonnet',
          allowedModels: ['sonnet'],
          eventVisibility: 'quiet',
          profileConcurrency: 1,
          runTimeoutMs: 1000,
          inactivityTimeoutMs: 1000,
          cancelGraceMs: 100,
          env: {},
        },
      ],
    },
    { env: {} },
  );
}

describe('server startup context', () => {
  it('applies schema and marks old queued runs interrupted', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'runner-index-test-'));
    const config = makeConfig(root);
    const setupDb = openRunnerDatabase(config.server.dataDir);
    applySchema(setupDb);
    const workspace = upsertWorkspace(setupDb, {
      id: 'ws_1',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
      now: 1000,
    });
    insertRunQueued(setupDb, {
      id: 'run_1',
      workspaceId: workspace.id,
      clientId: 'lqbot',
      profileId: 'report-docx',
      kind: 'revise',
      prompt: 'Queued run',
      now: 1000,
    });
    setupDb.close();

    const context = createServerContext(config, { clock: () => 2000 });

    expect(context.runService).toBeDefined();
    expect(context.interruptedRuns).toBe(1);
    expect(getRunDetail(context.db, { runId: 'run_1', clientId: 'lqbot' })?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
      finishedAt: 2000,
    });
    context.db.close();
  });
});

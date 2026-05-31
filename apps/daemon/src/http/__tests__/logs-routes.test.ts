import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../config/profiles.js';
import { createRunLogService } from '../../core/run-log-service.js';
import { createWorkspaceService } from '../../core/workspace-service.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import {
  createRunQueuedWithMessagesAndSnapshot,
  upsertWorkspace,
} from '../../db/repositories.js';
import { applySchema } from '../../db/schema.js';
import { createApp } from '../app.js';

const servers: Array<{ close: (callback: () => void) => void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(resolve);
        }),
    ),
  );
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfig(root: string): DaemonConfig {
  return parseDaemonConfig(
    {
      server: {
        host: '127.0.0.1',
        port: 17890,
        dataDir: path.join(root, 'data'),
        globalConcurrency: 4,
        maxQueueSize: 100,
      },
      clients: [
        { id: 'lqbot', apiKey: 'secret', allowedProfileIds: ['report-docx'], canReadLogs: true },
        { id: 'no-logs', apiKey: 'no-logs-secret', allowedProfileIds: ['report-docx'], canReadLogs: false },
        { id: 'other', apiKey: 'other-secret', allowedProfileIds: ['report-docx'], canReadLogs: true },
      ],
      profiles: [
        {
          id: 'report-docx',
          sandboxRoot: path.join(root, 'sandboxes'),
          claudeConfigDir: path.join(root, 'profiles/report-docx/claude'),
          claudeBin: 'claude',
          skillRoots: [path.join(root, 'skills')],
          allowedInputRoots: [path.join(root, 'uploads')],
          allowedSkillIds: ['report-writer'],
          artifactRules: [{ id: 'report-docx', pattern: 'output/**/*.docx', role: 'primary', required: true }],
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

async function withApp(callback: (context: { baseUrl: string; config: DaemonConfig }) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'logs-routes-test-'));
  tempDirs.push(root);
  const config = makeConfig(root);
  const db = openInMemoryDatabase();
  applySchema(db);
  const workspace = upsertWorkspace(db, {
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_123',
    now: 1000,
  });
  createRunQueuedWithMessagesAndSnapshot(db, {
    runId: 'run_1',
    conversationId: 'conv_1',
    userMessageId: 'msg_user',
    assistantMessageId: 'msg_assistant',
    workspaceId: workspace.id,
    profileId: workspace.profileId,
    clientId: workspace.clientId,
    kind: 'revise',
    prompt: 'Run.',
    profileSnapshot: { profileId: workspace.profileId },
    now: 2000,
  });
  const runLogService = createRunLogService({ config, db });
  const logs = runLogService.openRunLogs({ runId: 'run_1' });
  logs.stdout(`authorization: Bearer secret-token ${config.profiles[0]!.sandboxRoot} output/report.docx`);
  logs.stderr('stderr tail');
  logs.close();

  const app = createApp({
    config,
    db,
    workspaceService: createWorkspaceService({ db }),
    runLogService,
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback({ baseUrl: `http://127.0.0.1:${port}`, config });
}

describe('logs routes', () => {
  it('requires auth', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/logs`);

      expect(response.status).toBe(401);
    });
  });

  it('returns sanitized log tails for authorized clients', async () => {
    await withApp(async ({ baseUrl, config }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/logs`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        runId: 'run_1',
        logs: {
          stdout: expect.objectContaining({ available: true, tail: expect.any(String) }),
          stderr: expect.objectContaining({ available: true, tail: 'stderr tail' }),
          debugEvents: expect.objectContaining({ available: true }),
        },
      });
      expect(JSON.stringify(body)).not.toContain('secret-token');
      expect(JSON.stringify(body)).not.toContain(config.profiles[0]!.sandboxRoot);
      expect(JSON.stringify(body)).toContain('output/report.docx');
    });
  });

  it('denies clients without log permission', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/logs`, {
        headers: { Authorization: 'Bearer no-logs-secret' },
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: expect.objectContaining({ code: 'FORBIDDEN' }) });
    });
  });

  it('does not let another client read logs for the run', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/logs`, {
        headers: { Authorization: 'Bearer other-secret' },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    });
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../src/config/profiles.js';
import { createRunFeedbackService } from '../../src/core/run-feedback-service.js';
import { createWorkspaceService } from '../../src/core/workspace-service.js';
import { createApp } from '../../src/http/app.js';
import { createPostgresFilePersistenceHarness } from '../helpers/postgres-persistence-harness.js';
import { postgresTestHookTimeoutMs, requirePostgresTestUrl } from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;
const servers: Array<{ close: (callback: () => void) => void }> = [];
const tempDirs: string[] = [];
let harness: Awaited<ReturnType<typeof createPostgresFilePersistenceHarness>> | null = null;

beforeAll(async () => {
  harness = await createPostgresFilePersistenceHarness();
  expect(harness).not.toBeNull();
}, postgresTestHookTimeoutMs);

afterEach(async () => {
  try {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))));
    await harness?.resetData();
  } finally {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

afterAll(async () => {
  await harness?.cleanup();
  harness = null;
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
        persistence: {
          databaseUrl: 'postgres://user:pass@localhost:5432/lance_agent_daemon_test',
        },
      },
      clients: [
        { id: 'lqbot', apiKey: 'secret', allowedProfileIds: ['report-docx'], canReadLogs: true },
        { id: 'other', apiKey: 'other-secret', allowedProfileIds: ['report-docx'], canReadLogs: true },
      ],
      profiles: [
        {
          id: 'report-docx',
          sandboxRoot: path.join(root, 'sandboxes'),
          claudeConfigDir: path.join(root, 'profiles/report-docx/claude'),
          skillRoots: [path.join(root, 'skills')],
          allowedInputRoots: [path.join(root, 'uploads')],
          allowedSkillIds: ['report-writer'],
          artifactRules: [],
          defaultArtifactRuleIds: [],
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
  const root = mkdtempSync(path.join(tmpdir(), 'feedback-routes-test-'));
  tempDirs.push(root);
  const config = makeConfig(root);
  expect(harness).not.toBeNull();
  const persistence = harness!.persistence;
  const workspace = await persistence.upsertWorkspace({
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_1',
    now: 1000,
  });
  await persistence.createRunQueuedWithMessagesAndSnapshot({
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
  const app = createApp({
    config,
    persistence,
    workspaceService: createWorkspaceService({ persistence }),
    feedbackService: createRunFeedbackService({ persistence, clock: () => 3000, ids: { feedbackId: () => 'feedback_1' } }),
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback({ baseUrl: `http://127.0.0.1:${port}`, config });
}

postgresDescribe('feedback routes', () => {
  it('requires auth', async () => {
    await withApp(async ({ baseUrl }) => {
      expect((await fetch(`${baseUrl}/api/runs/run_1/feedback`)).status).toBe(401);
    });
  });

  it('creates and lists sanitized feedback for the owning client', async () => {
    await withApp(async ({ baseUrl, config }) => {
      const created = await fetch(`${baseUrl}/api/runs/run_1/feedback`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'custom.selector',
          message: `password=hunter2 ${config.profiles[0]!.sandboxRoot}`,
          metadata: { token: 'abc', artifactPath: 'output/report.docx' },
        }),
      });
      const listed = await fetch(`${baseUrl}/api/runs/run_1/feedback`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({
        feedback: expect.objectContaining({
          id: 'feedback_1',
          category: 'custom.selector',
          message: 'password=[redacted] [redacted-path]',
          metadata: { token: '[redacted]', artifactPath: 'output/report.docx' },
        }),
      });
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as { feedback: unknown[] };
      expect(listedBody.feedback).toHaveLength(1);
    });
  });

  it('does not let another client read feedback for the run', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/feedback`, {
        headers: { Authorization: 'Bearer other-secret' },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    });
  });
});

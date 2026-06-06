import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../src/config/profiles.js';
import { createReviewBundleService } from '../../src/core/review-bundle-service.js';
import { createRunLogService } from '../../src/core/run-log-service.js';
import { createWorkspaceService } from '../../src/core/workspace-service.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import {
  createRunQueuedWithMessagesAndSnapshot,
  upsertRunPromptSnapshot,
  upsertWorkspace,
} from '../../src/db/repositories.js';
import { applySchema } from '../../src/db/schema.js';
import { createApp } from '../../src/http/app.js';

const servers: Array<{ close: (callback: () => void) => void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))));
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

async function withApp(callback: (context: { baseUrl: string }) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'review-bundle-routes-test-'));
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
    projectId: 'project_1',
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
    kind: 'generate',
    prompt: 'Run.',
    profileSnapshot: { profileId: workspace.profileId },
    now: 2000,
  });
  upsertRunPromptSnapshot(db, {
    runId: 'run_1',
    promptSnapshot: 'final prompt',
    promptSnapshotHash: 'sha256:prompt',
    charCount: 12,
    byteCount: 12,
    persisted: true,
    now: 2100,
  });
  const runLogService = createRunLogService({ config, db });
  const logs = runLogService.openRunLogs({ runId: 'run_1' });
  logs.stdout('stdout');
  logs.close();
  const reviewBundleService = createReviewBundleService({ config, db, runLogService });
  const app = createApp({
    config,
    db,
    workspaceService: createWorkspaceService({ db }),
    runLogService,
    reviewBundleService,
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback({ baseUrl: `http://127.0.0.1:${port}` });
}

describe('review bundle routes', () => {
  it('requires auth', async () => {
    await withApp(async ({ baseUrl }) => {
      expect((await fetch(`${baseUrl}/api/runs/run_1/review-bundle/download`)).status).toBe(401);
    });
  });

  it('downloads a zip bundle for authorized clients', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/review-bundle/download`, {
        headers: { Authorization: 'Bearer secret' },
      });
      const body = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/zip');
      expect(response.headers.get('content-disposition')).toContain('review_bundle.zip');
      expect([...body.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    });
  });

  it('denies clients without log permission', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/review-bundle/download`, {
        headers: { Authorization: 'Bearer no-logs-secret' },
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: expect.objectContaining({ code: 'FORBIDDEN' }) });
    });
  });
});

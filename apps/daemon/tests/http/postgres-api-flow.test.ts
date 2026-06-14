import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../src/config/profiles.js';
import { createArtifactService } from '../../src/core/artifact-service.js';
import type { ClaudeCliRunResult } from '../../src/core/cli-runner.js';
import { createRunLogService } from '../../src/core/run-log-service.js';
import { createRunService, type RunServiceRunnerFactory } from '../../src/core/run-service.js';
import { createWorkspaceService } from '../../src/core/workspace-service.js';
import { createApp } from '../../src/http/app.js';
import { createPostgresPersistenceHarness } from '../helpers/postgres-persistence-harness.js';
import { requirePostgresTestUrl } from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;
const servers: Array<{ close: (callback: () => void) => void }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))));
});

postgresDescribe('postgres-backed api flow', () => {
  it('keeps representative HTTP response shapes stable on PostgreSQL persistence', async () => {
    const harness = await createPostgresPersistenceHarness();
    expect(harness).not.toBeNull();
    const root = mkdtempSync(path.join(tmpdir(), 'pg-api-flow-'));
    mkdirSync(path.join(root, 'uploads'), { recursive: true });
    writeSkill(root);
    const config = makeConfig(root, harness!.databaseUrl);
    const runnerResult = createDeferred<ClaudeCliRunResult>();
    const runnerFactory: RunServiceRunnerFactory = () => ({
      completed: runnerResult.promise,
      cancel: vi.fn(),
    });
    const workspaceService = createWorkspaceService({
      persistence: harness!.persistence,
      ids: { workspaceId: () => 'ws_pg_http' },
      clock: () => 1000,
    });
    const artifactService = createArtifactService({
      config,
      persistence: harness!.persistence,
      clock: () => 5000,
      ids: { artifactId: () => 'artifact_pg_http' },
    });
    const runLogService = createRunLogService({ config, persistence: harness!.persistence });
    const runService = createRunService({
      config,
      persistence: harness!.persistence,
      artifactService,
      runLogService,
      runnerFactory,
      capabilityProbe: async () => ({}),
      clock: () => 2000,
      ids: {
        runId: () => 'run_pg_http',
        conversationId: () => 'conv_pg_http',
        userMessageId: () => 'msg_pg_http_user',
        assistantMessageId: () => 'msg_pg_http_assistant',
      },
    });
    const app = createApp({
      config,
      persistence: harness!.persistence,
      workspaceService,
      runService,
      artifactService,
      runLogService,
    });
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          profileId: 'report-docx',
          workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_1' },
        }),
      });
      await expect(workspaceResponse.json()).resolves.toEqual({
        workspaceId: 'ws_pg_http',
        workspaceKey: 'lqbot/user_1/project_1',
      });

      const runBody = {
        profileId: 'report-docx',
        workspaceId: 'ws_pg_http',
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate.',
        idempotencyKey: 'pg-http-key',
      };
      const createRunResponse = await postJson(`${baseUrl}/api/runs`, runBody);
      expect(createRunResponse).toMatchObject({
        runId: 'run_pg_http',
        status: 'queued',
        conversationId: 'conv_pg_http',
        userMessageId: 'msg_pg_http_user',
        assistantMessageId: 'msg_pg_http_assistant',
      });
      const replayResponse = await postJson(`${baseUrl}/api/runs`, runBody);
      expect(replayResponse).toMatchObject({
        runId: 'run_pg_http',
        idempotentReplay: true,
      });

      const status = await getJson(`${baseUrl}/api/runs/run_pg_http/status`);
      expect(status).toMatchObject({
        run: {
          id: 'run_pg_http',
          status: expect.stringMatching(/queued|running/),
        },
        terminal: false,
      });
      const detail = await getJson(`${baseUrl}/api/runs/run_pg_http`);
      expect(detail).toMatchObject({
        run: { id: 'run_pg_http' },
        messages: [
          expect.objectContaining({ id: 'msg_pg_http_user', role: 'user' }),
          expect.objectContaining({ id: 'msg_pg_http_assistant', role: 'assistant' }),
        ],
      });

      const workspaceCwd = path.join(config.profiles[0]!.sandboxRoot, 'lqbot', 'user_1', 'project_1');
      mkdirSync(path.join(workspaceCwd, 'output'), { recursive: true });
      writeFileSync(path.join(workspaceCwd, 'output', 'report.docx'), 'docx');
      runnerResult.resolve({ status: 'succeeded', exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' });
      await eventually(async () => {
        const done = await getJson(`${baseUrl}/api/runs/run_pg_http/status`);
        expect(done.run.status).toBe('succeeded');
        expect(done.terminal).toBe(true);
      });

      const artifacts = await getJson(`${baseUrl}/api/runs/run_pg_http/artifacts`);
      expect(artifacts.artifacts).toEqual([
        expect.objectContaining({
          id: 'artifact_pg_http',
          runId: 'run_pg_http',
          role: 'primary',
          relativePath: 'output/report.docx',
        }),
      ]);
      const logs = await getJson(`${baseUrl}/api/runs/run_pg_http/logs`);
      expect(logs).toMatchObject({ runId: 'run_pg_http' });
    } finally {
      await harness!.cleanup();
    }
  });
});

function makeConfig(root: string, databaseUrl: string): DaemonConfig {
  return parseDaemonConfig(
    {
      server: {
        host: '127.0.0.1',
        port: 17890,
        dataDir: path.join(root, 'data'),
        globalConcurrency: 4,
        maxQueueSize: 100,
        persistence: { databaseUrl },
      },
      clients: [{ id: 'lqbot', apiKey: 'secret', allowedProfileIds: ['report-docx'], canReadLogs: true }],
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

function writeSkill(root: string): void {
  const skillDir = path.join(root, 'skills', 'report-writer');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
id: report-writer
name: Report Writer
description: Writes reports.
---
Write the requested report.
`,
  );
}

function authHeaders(): Record<string, string> {
  return { authorization: 'Bearer secret', 'content-type': 'application/json' };
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202);
  return response.json();
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: authHeaders() });
  expect(response.status).toBe(200);
  return response.json();
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

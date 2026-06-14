import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../src/config/profiles.js';
import type { RunService } from '../../src/core/run-service.js';
import { createWorkspaceService } from '../../src/core/workspace-service.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { applySchema } from '../../src/db/schema.js';
import { createApp } from '../../src/http/app.js';

const servers: Array<{ close: (callback: () => void) => void }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(resolve);
        }),
    ),
  );
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

function memoryLogger() {
  const records: Array<{ level: string; event: string; data: Record<string, unknown> }> = [];
  return {
    logger: {
      debug: (event: string, data: Record<string, unknown> = {}) => records.push({ level: 'debug', event, data }),
      info: (event: string, data: Record<string, unknown> = {}) => records.push({ level: 'info', event, data }),
      warn: (event: string, data: Record<string, unknown> = {}) => records.push({ level: 'warn', event, data }),
      error: (event: string, data: Record<string, unknown> = {}) => records.push({ level: 'error', event, data }),
    },
    records,
  };
}

async function withApp(
  input: { runService?: Partial<RunService> },
  callback: (context: { baseUrl: string; records: ReturnType<typeof memoryLogger>['records'] }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'app-logging-test-'));
  const config = makeConfig(root);
  const db = openInMemoryDatabase();
  applySchema(db);
  const { logger, records } = memoryLogger();
  const app = createApp({
    config,
    db,
    workspaceService: createWorkspaceService({ db }),
    runService: input.runService as RunService | undefined,
    daemonLogger: logger,
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback({ baseUrl: `http://127.0.0.1:${port}`, records });
}

describe('app service logging', () => {
  it('records HTTP request summaries without authorization headers', async () => {
    await withApp({}, async ({ baseUrl, records }) => {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      expect(records).toContainEqual(
        expect.objectContaining({
          event: 'http_request',
          level: 'info',
          data: expect.objectContaining({
            method: 'GET',
            path: '/api/health',
            statusCode: 200,
          }),
        }),
      );
      expect(JSON.stringify(records)).not.toContain('secret');
      expect(JSON.stringify(records)).not.toContain('authorization');
    });
  });

  it('records internal errors locally while returning generic API errors', async () => {
    await withApp(
      {
        runService: {
          getRunStatus: () => {
            throw new Error('download header exploded');
          },
        },
      },
      async ({ baseUrl, records }) => {
        const response = await fetch(`${baseUrl}/api/runs/run_1/status`, {
          headers: { Authorization: 'Bearer secret' },
        });

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
        expect(records).toContainEqual(
          expect.objectContaining({
            event: 'http_error',
            level: 'error',
            data: expect.objectContaining({
              errorMessage: 'download header exploded',
              errorName: 'Error',
              method: 'GET',
              path: '/api/runs/run_1/status',
              statusCode: 500,
            }),
          }),
        );
      },
    );
  });
});

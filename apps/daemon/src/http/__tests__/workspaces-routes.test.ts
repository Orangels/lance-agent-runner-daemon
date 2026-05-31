import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../config/profiles.js';
import { createWorkspaceService } from '../../core/workspace-service.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import { applySchema } from '../../db/schema.js';
import { createApp } from '../app.js';

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
      },
      clients: [
        {
          id: 'lqbot',
          apiKey: 'secret',
          allowedProfileIds: ['report-docx'],
          canReadDebugEvents: false,
          canReadLogs: true,
        },
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
          env: {
            ANTHROPIC_API_KEY: 'secret-anthropic-key',
          },
        },
      ],
    },
    { env: {} },
  );
}

async function withApp(
  callback: (baseUrl: string, root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-http-test-'));
  mkdirSync(path.join(root, 'uploads'), { recursive: true });
  const config = makeConfig(root);
  const db = openInMemoryDatabase();
  applySchema(db);
  const app = createApp({
    config,
    db,
    workspaceService: createWorkspaceService({
      db,
      ids: { workspaceId: () => 'ws_1' },
      clock: () => 1000,
    }),
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback(`http://127.0.0.1:${port}`, root);
}

describe('health route', () => {
  it('returns ok without auth', async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });
  });
});

describe('profiles route', () => {
  it('requires auth', async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/profiles`);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'Missing API key' },
      });
    });
  });

  it('returns allowed public profile data without internal paths or secrets', async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/profiles`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.profiles).toEqual([
        expect.objectContaining({
          id: 'report-docx',
          defaultModel: 'sonnet',
          allowedModels: ['sonnet'],
          eventVisibility: 'quiet',
        }),
      ]);
      expect(JSON.stringify(body)).not.toContain('sandboxRoot');
      expect(JSON.stringify(body)).not.toContain('claudeConfigDir');
      expect(JSON.stringify(body)).not.toContain('skillRoots');
      expect(JSON.stringify(body)).not.toContain('allowedInputRoots');
      expect(JSON.stringify(body)).not.toContain('secret-anthropic-key');
    });
  });
});

describe('request body errors', () => {
  it('maps malformed JSON bodies to a generic 400 without leaking parser details', async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: '{"profileId":',
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: 'BAD_REQUEST', message: 'Invalid request body' },
      });
    });
  });

  it('maps oversized JSON bodies to a generic 413 without leaking parser details', async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: 'x'.repeat(1_100_000) }),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: { code: 'BAD_REQUEST', message: 'Invalid request body' },
      });
    });
  });
});

describe('workspace routes', () => {
  it('creates or gets a workspace', async () => {
    await withApp(async (baseUrl, root) => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        workspaceId: 'ws_1',
        workspaceKey: 'lqbot/user_1/project_123',
      });
      expect(JSON.stringify(body)).not.toContain(root);
    });
  });

  it('rejects unauthorized profile access', async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'other-profile',
          workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
        }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: expect.objectContaining({ code: 'PROFILE_NOT_ALLOWED' }),
      });
    });
  });

  it('prepares allowed files without exposing absolute paths', async () => {
    await withApp(async (baseUrl, root) => {
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
        }),
      });
      const workspace = (await createResponse.json()) as { workspaceId: string };
      const sourcePath = path.join(root, 'uploads/source.docx');
      writeFileSync(sourcePath, 'source content');

      const prepareResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.workspaceId}/prepare`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: [{ sourcePath, targetPath: 'input/source.docx' }],
          }),
        },
      );

      expect(prepareResponse.status).toBe(200);
      const body = await prepareResponse.json();
      expect(body).toEqual({
        workspaceId: 'ws_1',
        workspaceKey: 'lqbot/user_1/project_123',
        files: [{ targetPath: 'input/source.docx', size: 14 }],
      });
      expect(JSON.stringify(body)).not.toContain(root);
    });
  });

  it('maps unsafe path validation to structured path errors', async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspace: { originId: 'lqbot', userId: '../user', projectId: 'project_123' },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: expect.objectContaining({ code: 'INVALID_PATH_SEGMENT' }),
      });
    });
  });

  it('does not leak absolute paths from unexpected filesystem errors', async () => {
    await withApp(async (baseUrl, root) => {
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'report-docx',
          workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
        }),
      });
      const workspace = (await createResponse.json()) as { workspaceId: string };
      const missingSourcePath = path.join(root, 'uploads/missing.docx');

      const prepareResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.workspaceId}/prepare`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: [{ sourcePath: missingSourcePath, targetPath: 'input/source.docx' }],
          }),
        },
      );

      expect(prepareResponse.status).toBe(500);
      const body = await prepareResponse.json();
      expect(body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
      expect(JSON.stringify(body)).not.toContain(root);
      expect(JSON.stringify(body)).not.toContain('missing.docx');
    });
  });
});

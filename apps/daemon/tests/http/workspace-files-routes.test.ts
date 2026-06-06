import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../src/config/profiles.js';
import { createUploadTempService, type UploadTempService } from '../../src/core/upload-temp-service.js';
import { createWorkspaceService, getWorkspaceCwd } from '../../src/core/workspace-service.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { upsertWorkspace } from '../../src/db/repositories.js';
import { applySchema } from '../../src/db/schema.js';
import { createApp } from '../../src/http/app.js';

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

function makeConfig(root: string, input: { maxUploadBytesPerFile?: number } = {}): DaemonConfig {
  return parseDaemonConfig(
    {
      server: {
        host: '127.0.0.1',
        port: 17890,
        dataDir: path.join(root, 'data'),
        globalConcurrency: 4,
        maxQueueSize: 100,
        maxUploadBytesPerFile: input.maxUploadBytesPerFile,
      },
      clients: [
        {
          id: 'lqbot',
          apiKey: 'secret',
          allowedProfileIds: ['report-docx'],
          canReadDebugEvents: false,
          canReadLogs: true,
        },
        {
          id: 'other',
          apiKey: 'other-secret',
          allowedProfileIds: ['report-docx'],
          canReadDebugEvents: false,
          canReadLogs: true,
        },
        {
          id: 'blocked',
          apiKey: 'blocked-secret',
          allowedProfileIds: [],
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
          env: {},
        },
      ],
    },
    { env: {} },
  );
}

async function withApp(
  callback: (context: {
    baseUrl: string;
    config: DaemonConfig;
    root: string;
    uploadTempService: UploadTempService;
    workspaceId: string;
    blockedWorkspaceId: string;
  }) => Promise<void>,
  input: { maxUploadBytesPerFile?: number } = {},
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-upload-route-test-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'uploads'), { recursive: true });
  const config = makeConfig(root, input);
  const db = openInMemoryDatabase();
  applySchema(db);
  const workspaceService = createWorkspaceService({
    db,
    ids: { workspaceId: () => 'ws_1' },
    clock: () => 1000,
  });
  const workspace = workspaceService.createOrGetWorkspace({
    clientId: 'lqbot',
    profile: config.profiles[0],
    workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
  });
  upsertWorkspace(db, {
    id: 'ws_blocked',
    clientId: 'blocked',
    profileId: 'report-docx',
    originId: 'blocked',
    userId: 'user_1',
    projectId: 'project_123',
    status: 'active',
    now: 1000,
  });
  const uploadTempService = createUploadTempService({ config });
  const app = createApp({
    config,
    db,
    workspaceService,
    uploadTempService,
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback({
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    root,
    uploadTempService,
    workspaceId: workspace.workspaceId,
    blockedWorkspaceId: 'ws_blocked',
  });
}

function uploadForm(input: {
  targetPath?: string;
  files?: Array<{ fieldName?: string; name: string; content: string; type?: string }>;
}): FormData {
  const form = new FormData();
  if (input.targetPath !== undefined) {
    form.set('targetPath', input.targetPath);
  }
  for (const file of input.files ?? []) {
    form.append(
      file.fieldName ?? 'file',
      new Blob([file.content], { type: file.type ?? 'text/plain' }),
      file.name,
    );
  }
  return form;
}

function expectTempRootEmpty(uploadTempService: UploadTempService): void {
  const tempRoot = uploadTempService.getTempRoot();
  if (!existsSync(tempRoot)) {
    return;
  }
  expect(readdirSync(tempRoot)).toEqual([]);
}

describe('workspace files route', () => {
  it('requires auth before accepting multipart uploads', async () => {
    await withApp(async ({ baseUrl, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        body: uploadForm({
          targetPath: 'input/source.txt',
          files: [{ name: 'source.txt', content: 'uploaded content' }],
        }),
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'Missing API key' },
      });
    });
  });

  it('uploads one file into the workspace and returns public metadata', async () => {
    await withApp(async ({ baseUrl, config, root, uploadTempService, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: uploadForm({
          targetPath: 'input/source.txt',
          files: [{ name: 'source.txt', content: 'uploaded content', type: 'text/plain' }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        workspaceId: 'ws_1',
        workspaceKey: 'lqbot/user_1/project_123',
        file: {
          targetPath: 'input/source.txt',
          size: 16,
          originalName: 'source.txt',
          mimeType: 'text/plain',
        },
      });
      const cwd = getWorkspaceCwd(config.profiles[0], {
        originId: 'lqbot',
        userId: 'user_1',
        projectId: 'project_123',
      });
      expect(readFileSync(path.join(cwd, 'input/source.txt'), 'utf8')).toBe('uploaded content');
      expect(JSON.stringify(body)).not.toContain(root);
      expect(JSON.stringify(body)).not.toContain(uploadTempService.getTempRoot());
      expectTempRootEmpty(uploadTempService);
    });
  });

  it('rejects missing file uploads', async () => {
    await withApp(async ({ baseUrl, uploadTempService, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: uploadForm({ targetPath: 'input/source.txt' }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: 'BAD_REQUEST', message: 'Missing upload file' },
      });
      expectTempRootEmpty(uploadTempService);
    });
  });

  it('rejects missing targetPath fields', async () => {
    await withApp(async ({ baseUrl, uploadTempService, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: uploadForm({ files: [{ name: 'source.txt', content: 'uploaded content' }] }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }),
      });
      expectTempRootEmpty(uploadTempService);
    });
  });

  it('rejects unsafe workspace-relative targets', async () => {
    await withApp(async ({ baseUrl, uploadTempService, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: uploadForm({
          targetPath: '../source.txt',
          files: [{ name: 'source.txt', content: 'uploaded content' }],
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }),
      });
      expectTempRootEmpty(uploadTempService);
    });
  });

  it('rejects protected skill staging targets', async () => {
    await withApp(async ({ baseUrl, uploadTempService, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: uploadForm({
          targetPath: '.claude-runner-skills/source.txt',
          files: [{ name: 'source.txt', content: 'uploaded content' }],
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }),
      });
      expectTempRootEmpty(uploadTempService);
    });
  });

  it('rejects duplicate file fields', async () => {
    await withApp(async ({ baseUrl, uploadTempService, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: uploadForm({
          targetPath: 'input/source.txt',
          files: [
            { name: 'source-a.txt', content: 'a' },
            { name: 'source-b.txt', content: 'b' },
          ],
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: 'BAD_REQUEST',
          message: 'Expected exactly one file field named file',
        },
      });
      expectTempRootEmpty(uploadTempService);
    });
  });

  it('maps oversized uploads to 413 and removes multer temp directories', async () => {
    await withApp(
      async ({ baseUrl, uploadTempService, workspaceId }) => {
        const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
          method: 'POST',
          headers: { Authorization: 'Bearer secret' },
          body: uploadForm({
            targetPath: 'input/source.txt',
            files: [{ name: 'source.txt', content: 'too large' }],
          }),
        });

        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({
          error: { code: 'BAD_REQUEST', message: 'Uploaded file is too large' },
        });
        expectTempRootEmpty(uploadTempService);
      },
      { maxUploadBytesPerFile: 4 },
    );
  });

  it('returns not found when another client uploads into this workspace', async () => {
    await withApp(async ({ baseUrl, uploadTempService, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer other-secret' },
        body: uploadForm({
          targetPath: 'input/source.txt',
          files: [{ name: 'source.txt', content: 'uploaded content' }],
        }),
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: expect.objectContaining({ code: 'NOT_FOUND' }),
      });
      expectTempRootEmpty(uploadTempService);
    });
  });

  it('returns profile forbidden when the owning client lacks profile access', async () => {
    await withApp(async ({ baseUrl, blockedWorkspaceId, uploadTempService }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${blockedWorkspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer blocked-secret' },
        body: uploadForm({
          targetPath: 'input/source.txt',
          files: [{ name: 'source.txt', content: 'uploaded content' }],
        }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: expect.objectContaining({ code: 'PROFILE_NOT_ALLOWED' }),
      });
      expectTempRootEmpty(uploadTempService);
    });
  });

  it('overwrites an existing workspace file', async () => {
    await withApp(async ({ baseUrl, config, workspaceId }) => {
      const cwd = getWorkspaceCwd(config.profiles[0], {
        originId: 'lqbot',
        userId: 'user_1',
        projectId: 'project_123',
      });
      writeFileSync(path.join(cwd, 'input/source.txt'), 'old');

      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: uploadForm({
          targetPath: 'input/source.txt',
          files: [{ name: 'source.txt', content: 'new upload' }],
        }),
      });

      expect(response.status).toBe(200);
      expect(readFileSync(path.join(cwd, 'input/source.txt'), 'utf8')).toBe('new upload');
    });
  });

  it('rejects existing directory targets', async () => {
    await withApp(async ({ baseUrl, uploadTempService, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: uploadForm({
          targetPath: 'input',
          files: [{ name: 'source.txt', content: 'uploaded content' }],
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }),
      });
      expectTempRootEmpty(uploadTempService);
    });
  });

  it('rejects wrong file field names', async () => {
    await withApp(async ({ baseUrl, uploadTempService, workspaceId }) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: uploadForm({
          targetPath: 'input/source.txt',
          files: [{ fieldName: 'document', name: 'source.txt', content: 'uploaded content' }],
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: 'BAD_REQUEST',
          message: 'Expected exactly one file field named file',
        },
      });
      expectTempRootEmpty(uploadTempService);
    });
  });
});

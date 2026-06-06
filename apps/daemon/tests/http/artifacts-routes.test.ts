import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../src/config/profiles.js';
import { createArtifactService } from '../../src/core/artifact-service.js';
import { createWorkspaceService, getWorkspaceCwd } from '../../src/core/workspace-service.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { insertRunQueued, replaceArtifactsForRun, upsertWorkspace } from '../../src/db/repositories.js';
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
      },
      clients: [
        { id: 'lqbot', apiKey: 'secret', allowedProfileIds: ['report-docx'] },
        { id: 'other', apiKey: 'other-secret', allowedProfileIds: ['report-docx'] },
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
  callback: (context: { baseUrl: string; config: DaemonConfig }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'artifact-routes-test-'));
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
  insertRunQueued(db, {
    id: 'run_1',
    workspaceId: workspace.id,
    clientId: 'lqbot',
    profileId: 'report-docx',
    kind: 'generate',
    skillId: 'report-writer',
    prompt: 'Generate.',
    now: 1000,
  });
  const workspaceCwd = getWorkspaceCwd(config.profiles[0]!, workspace);
  mkdirSync(path.join(workspaceCwd, 'output'), { recursive: true });
  writeFileSync(path.join(workspaceCwd, 'output', 'report.docx'), 'docx');
  writeFileSync(path.join(workspaceCwd, 'output', 'output_2025年8月_临高县公安局报告.docx'), 'docx-zh');
  replaceArtifactsForRun(db, {
    runId: 'run_1',
    workspaceId: workspace.id,
    artifacts: [
      {
        id: 'artifact_1',
        ruleId: 'report-docx',
        role: 'primary',
        relativePath: 'output/report.docx',
        fileName: 'report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 4,
        mtime: 1770000000000,
        sha256: 'abc123',
      },
      {
        id: 'artifact_zh',
        ruleId: 'report-docx',
        role: 'primary',
        relativePath: 'output/output_2025年8月_临高县公安局报告.docx',
        fileName: 'output_2025年8月_临高县公安局报告.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 7,
        mtime: 1770000000000,
        sha256: 'def456',
      },
    ],
    now: 5000,
  });

  const app = createApp({
    config,
    db,
    workspaceService: createWorkspaceService({ db }),
    artifactService: createArtifactService({ config, db }),
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback({ baseUrl: `http://127.0.0.1:${port}`, config });
}

describe('artifact routes', () => {
  it('requires auth for listing artifacts', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/artifacts`);

      expect(response.status).toBe(401);
    });
  });

  it('lists artifacts without sandbox absolute paths', async () => {
    await withApp(async ({ baseUrl, config }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/artifacts`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { artifacts: unknown[] };
      expect(body.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'artifact_1',
            runId: 'run_1',
            workspaceId: 'ws_1',
            ruleId: 'report-docx',
            role: 'primary',
            relativePath: 'output/report.docx',
            fileName: 'report.docx',
          }),
        ]),
      );
      expect(JSON.stringify(body)).not.toContain(config.profiles[0]!.sandboxRoot);
    });
  });

  it('streams artifact downloads for authorized clients', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/artifacts/artifact_1/download`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      expect(await response.text()).toBe('docx');
    });
  });

  it('streams downloads with UTF-8 filenames in content-disposition', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/runs/run_1/artifacts/artifact_zh/download`, {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(response.status).toBe(200);
      const disposition = response.headers.get('content-disposition');
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('filename="output_2025_8.docx"');
      expect(disposition).toContain("filename*=UTF-8''output_2025%E5%B9%B48%E6%9C%88_%E4%B8%B4%E9%AB%98%E5%8E%BF%E5%85%AC%E5%AE%89%E5%B1%80%E6%8A%A5%E5%91%8A.docx");
      expect(await response.text()).toBe('docx-zh');
    });
  });

  it('does not let another client list or download artifacts for the run', async () => {
    await withApp(async ({ baseUrl }) => {
      const list = await fetch(`${baseUrl}/api/runs/run_1/artifacts`, {
        headers: { Authorization: 'Bearer other-secret' },
      });
      const download = await fetch(`${baseUrl}/api/runs/run_1/artifacts/artifact_1/download`, {
        headers: { Authorization: 'Bearer other-secret' },
      });

      expect(list.status).toBe(404);
      expect(download.status).toBe(404);
    });
  });
});

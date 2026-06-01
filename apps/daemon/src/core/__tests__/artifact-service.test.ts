import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../config/profiles.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import {
  getArtifactForRunForClient,
  insertRunQueued,
  upsertWorkspace,
  type WorkspaceRecord,
} from '../../db/repositories.js';
import { applySchema } from '../../db/schema.js';
import { DaemonError } from '../errors.js';
import { createArtifactService } from '../artifact-service.js';
import { getWorkspaceCwd } from '../workspace-service.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'artifact-service-test-'));
  tempRoots.push(root);
  return root;
}

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
        { id: 'admin', apiKey: 'admin-secret', allowedProfileIds: [], isAdmin: true },
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
            { id: 'debug-md', pattern: 'work/**/*.md', role: 'debug', required: false },
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

function setup() {
  const root = makeRoot();
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
  const otherWorkspace = upsertWorkspace(db, {
    id: 'ws_2',
    clientId: 'other',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_2',
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
  insertRunQueued(db, {
    id: 'run_2',
    workspaceId: otherWorkspace.id,
    clientId: 'other',
    profileId: 'report-docx',
    kind: 'generate',
    skillId: 'report-writer',
    prompt: 'Generate.',
    now: 1000,
  });
  const service = createArtifactService({
    config,
    db,
    clock: () => 5000,
    ids: { artifactId: () => 'artifact_1' },
  });
  return {
    root,
    config,
    db,
    service,
    workspace,
    otherWorkspace,
    profile: config.profiles[0]!,
    client: config.clients[0]!,
    otherClient: config.clients[1]!,
    adminClient: config.clients[2]!,
  };
}

function writeWorkspaceFile(
  profile: DaemonConfig['profiles'][number],
  workspace: WorkspaceRecord,
  relativePath: string,
  content: string,
): string {
  const filePath = path.join(getWorkspaceCwd(profile, workspace), relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

describe('artifact service', () => {
  it('resolves default and explicit artifact rules with request-order de-dupe', () => {
    const { service, profile } = setup();

    expect(service.resolveSelectedArtifactRules({ profile }).map((rule) => rule.id)).toEqual([
      'report-docx',
    ]);
    expect(
      service
        .resolveSelectedArtifactRules({
          profile,
          artifactRuleIds: ['debug-md', 'report-docx', 'debug-md'],
        })
        .map((rule) => rule.id),
    ).toEqual(['debug-md', 'report-docx']);
    expect(() =>
      service.resolveSelectedArtifactRules({ profile, artifactRuleIds: ['missing'] }),
    ).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it('finalizes found artifacts, reports required missing, and persists public metadata only', async () => {
    const { service, profile, workspace, db } = setup();
    const filePath = writeWorkspaceFile(profile, workspace, 'output/report.docx', 'docx');

    const finalized = await service.finalizeRunArtifacts({
      profile,
      workspace,
      runId: 'run_1',
      artifactRuleIds: ['report-docx', 'debug-md'],
    });

    expect(finalized.missingRequiredRuleIds).toEqual([]);
    expect(finalized.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact_1',
        runId: 'run_1',
        workspaceId: 'ws_1',
        ruleId: 'report-docx',
        role: 'primary',
        relativePath: 'output/report.docx',
        fileName: 'report.docx',
      }),
    ]);
    expect(JSON.stringify(finalized.artifacts)).not.toContain(profile.sandboxRoot);
    expect(
      getArtifactForRunForClient(db, {
        runId: 'run_1',
        artifactId: 'artifact_1',
        clientId: 'lqbot',
      }),
    ).toMatchObject({ relativePath: 'output/report.docx' });

    rmSync(filePath);
    const missing = await service.finalizeRunArtifacts({
      profile,
      workspace,
      runId: 'run_1',
      artifactRuleIds: ['report-docx', 'debug-md'],
    });
    expect(missing.missingRequiredRuleIds).toEqual(['report-docx']);
  });

  it('keeps the highest-priority role when multiple artifact rules match the same file', async () => {
    const { config, profile, workspace, db } = setup();
    let artifactSequence = 0;
    const service = createArtifactService({
      config,
      db,
      clock: () => 5000,
      ids: { artifactId: () => `artifact_${++artifactSequence}` },
    });
    writeWorkspaceFile(profile, workspace, 'output/report.docx', 'docx');
    writeWorkspaceFile(profile, workspace, 'output/debug.json', '{}');

    const finalized = await service.finalizeRunArtifacts({
      profile: {
        ...profile,
        artifactRules: [
          { id: 'debug-all', pattern: 'output/**/*', role: 'debug', required: false },
          { id: 'supporting-all', pattern: 'output/**/*', role: 'supporting', required: false },
          { id: 'report-docx', pattern: 'output/**/*.docx', role: 'primary', required: true },
        ],
      },
      workspace,
      runId: 'run_1',
      artifactRuleIds: ['debug-all', 'supporting-all', 'report-docx'],
    });

    expect(finalized.missingRequiredRuleIds).toEqual([]);
    expect(finalized.artifacts.map((artifact) => `${artifact.relativePath}:${artifact.role}:${artifact.ruleId}`)).toEqual([
      'output/report.docx:primary:report-docx',
      'output/debug.json:supporting:supporting-all',
    ]);
    expect(
      getArtifactForRunForClient(db, {
        runId: 'run_1',
        artifactId: 'artifact_1',
        clientId: 'lqbot',
      }),
    ).toMatchObject({ relativePath: 'output/debug.json', role: 'supporting' });
  });

  it('surfaces scan failures as ARTIFACT_SCAN_FAILED without leaking paths', async () => {
    const { config, db, profile, workspace } = setup();
    const service = createArtifactService({
      config,
      db,
      scanner: async () => {
        throw new Error(`/private/root/${workspace.id}/boom`);
      },
    });

    await expect(
      service.finalizeRunArtifacts({
        profile,
        workspace,
        runId: 'run_1',
        artifactRuleIds: ['report-docx'],
      }),
    ).rejects.toMatchObject({
      code: 'ARTIFACT_SCAN_FAILED',
      message: 'Artifact scan failed',
    });
  });

  it('lists and resolves downloads through run/client authorization', async () => {
    const { service, profile, workspace, client, otherClient, adminClient } = setup();
    const filePath = writeWorkspaceFile(profile, workspace, 'output/report.docx', 'docx');
    await service.finalizeRunArtifacts({
      profile,
      workspace,
      runId: 'run_1',
      artifactRuleIds: ['report-docx'],
    });

    expect(service.listRunArtifacts({ client, runId: 'run_1' })).toEqual([
      expect.objectContaining({ id: 'artifact_1', relativePath: 'output/report.docx' }),
    ]);
    expect(service.listRunArtifacts({ client: adminClient, runId: 'run_1' })).toHaveLength(1);
    expect(() => service.listRunArtifacts({ client: otherClient, runId: 'run_1' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );

    const download = await service.getRunArtifactDownload({
      client,
      runId: 'run_1',
      artifactId: 'artifact_1',
    });
    expect(download).toEqual({
      artifact: expect.objectContaining({ id: 'artifact_1', relativePath: 'output/report.docx' }),
      filePath,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'report.docx',
      size: 4,
    });
    expect(JSON.stringify(download.artifact)).not.toContain(profile.sandboxRoot);
  });

  it('returns NOT_FOUND when the artifact file no longer exists on disk', async () => {
    const { service, profile, workspace, client } = setup();
    const filePath = writeWorkspaceFile(profile, workspace, 'output/report.docx', 'docx');
    await service.finalizeRunArtifacts({
      profile,
      workspace,
      runId: 'run_1',
      artifactRuleIds: ['report-docx'],
    });
    rmSync(filePath);

    await expect(
      service.getRunArtifactDownload({ client, runId: 'run_1', artifactId: 'artifact_1' }),
    ).rejects.toBeInstanceOf(DaemonError);
    await expect(
      service.getRunArtifactDownload({ client, runId: 'run_1', artifactId: 'artifact_1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseDaemonConfig, type DaemonConfig } from '../../src/config/profiles.js';
import { DaemonError } from '../../src/core/errors.js';
import { createArtifactService } from '../../src/core/artifact-service.js';
import { getWorkspaceCwd } from '../../src/core/workspace-service.js';
import type { WorkspaceRecord } from '../../src/db/types.js';
import { createPostgresFilePersistenceHarness } from '../helpers/postgres-persistence-harness.js';
import { postgresTestHookTimeoutMs, requirePostgresTestUrl } from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;

const tempRoots: string[] = [];
let harness: Awaited<ReturnType<typeof createPostgresFilePersistenceHarness>> | null = null;

beforeAll(async () => {
  harness = await createPostgresFilePersistenceHarness();
  expect(harness).not.toBeNull();
}, postgresTestHookTimeoutMs);

afterEach(async () => {
  try {
    await harness?.resetData();
  } finally {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

afterAll(async () => {
  await harness?.cleanup();
  harness = null;
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
        persistence: {
          databaseUrl: 'postgres://user:pass@localhost:5432/lance_agent_daemon_test',
        },
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

async function setup() {
  const root = makeRoot();
  const config = makeConfig(root);
  expect(harness).not.toBeNull();
  const persistence = harness!.persistence;
  const workspace = await persistence.upsertWorkspace({
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_123',
    now: 1000,
  });
  const otherWorkspace = await persistence.upsertWorkspace({
    id: 'ws_2',
    clientId: 'other',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_2',
    projectId: 'project_123',
    now: 1000,
  });
  await persistence.insertRunQueued({
    id: 'run_1',
    workspaceId: workspace.id,
    clientId: 'lqbot',
    profileId: 'report-docx',
    kind: 'generate',
    skillId: 'report-writer',
    prompt: 'Generate.',
    now: 1000,
  });
  await persistence.insertRunQueued({
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
    persistence,
    clock: () => 5000,
    ids: { artifactId: () => 'artifact_1' },
  });
  return {
    root,
    config,
    persistence,
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

postgresDescribe('artifact service', () => {
  it('resolves default and explicit artifact rules with request-order de-dupe', async () => {
    const { service, profile } = await setup();

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
    const { service, profile, workspace, persistence } = await setup();
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
      await persistence.getArtifactForRunForClient({
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
    const { config, profile, workspace, persistence } = await setup();
    let artifactSequence = 0;
    const service = createArtifactService({
      config,
      persistence,
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
      await persistence.getArtifactForRunForClient({
        runId: 'run_1',
        artifactId: 'artifact_1',
        clientId: 'lqbot',
      }),
    ).toMatchObject({ relativePath: 'output/debug.json', role: 'supporting' });
  });

  it('surfaces scan failures as ARTIFACT_SCAN_FAILED without leaking paths', async () => {
    const { config, persistence, profile, workspace } = await setup();
    const service = createArtifactService({
      config,
      persistence,
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
    const { service, profile, workspace, client, otherClient, adminClient } = await setup();
    const filePath = writeWorkspaceFile(profile, workspace, 'output/report.docx', 'docx');
    await service.finalizeRunArtifacts({
      profile,
      workspace,
      runId: 'run_1',
      artifactRuleIds: ['report-docx'],
    });

    await expect(service.listRunArtifacts({ client, runId: 'run_1' })).resolves.toEqual([
      expect.objectContaining({ id: 'artifact_1', relativePath: 'output/report.docx' }),
    ]);
    await expect(service.listRunArtifacts({ client: adminClient, runId: 'run_1' })).resolves.toHaveLength(1);
    await expect(service.listRunArtifacts({ client: otherClient, runId: 'run_1' })).rejects.toThrow(
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
    const { service, profile, workspace, client } = await setup();
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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ProfileConfig } from '../../src/config/profiles.js';
import { DaemonError } from '../../src/core/errors.js';
import { createWorkspaceService, getWorkspaceCwd } from '../../src/core/workspace-service.js';
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

function makeProfile(root: string, uploadsRoot: string): ProfileConfig {
  return {
    id: 'report-docx',
    sandboxRoot: path.join(root, 'sandboxes'),
    claudeConfigDir: path.join(root, 'profiles/report-docx/claude'),
    claudeBin: 'claude',
    skillRoots: [path.join(root, 'skills')],
    allowedInputRoots: [uploadsRoot],
    allowedSkillIds: ['report-writer'],
    artifactRules: [{ id: 'report-docx', pattern: 'output/**/*.docx', role: 'primary', required: true }],
    defaultArtifactRuleIds: ['report-docx'],
    permissionMode: 'bypassPermissions',
    defaultModel: 'sonnet',
    allowedModels: ['sonnet'],
    eventVisibility: 'quiet',
    maxCollectionMode: 'lite',
    profileConcurrency: 1,
    runTimeoutMs: 1000,
    inactivityTimeoutMs: 1000,
    cancelGraceMs: 100,
    env: {},
  };
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-workspace-test-'));
  tempRoots.push(root);
  const uploadsRoot = path.join(root, 'uploads');
  mkdirSync(uploadsRoot, { recursive: true });
  const profile = makeProfile(root, uploadsRoot);
  expect(harness).not.toBeNull();
  const persistence = harness!.persistence;
  const service = createWorkspaceService({
    persistence,
    ids: {
      workspaceId: () => 'ws_1',
    },
    clock: () => 1000,
  });
  return { root, uploadsRoot, profile, service };
}

postgresDescribe('workspace creation', () => {
  it('creates the workspace directory skeleton', async () => {
    const { profile, service } = await setup();

    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });

    const cwd = getWorkspaceCwd(profile, {
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
    });
    expect(workspace).toEqual({
      workspaceId: 'ws_1',
      workspaceKey: 'lqbot/user_1/project_123',
    });
    expect(statSync(path.join(cwd, 'input')).isDirectory()).toBe(true);
    expect(statSync(path.join(cwd, 'output')).isDirectory()).toBe(true);
    expect(statSync(path.join(cwd, 'work')).isDirectory()).toBe(true);
    expect(statSync(path.join(cwd, '.claude-runner-skills')).isDirectory()).toBe(true);
  });

  it('returns the existing workspace id on create-or-get', async () => {
    const { profile, service } = await setup();

    await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const again = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });

    expect(again.workspaceId).toBe('ws_1');
  });

  it('does not expose absolute workspace paths in the public response', async () => {
    const { profile, service } = await setup();

    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });

    expect(JSON.stringify(workspace)).not.toContain(profile.sandboxRoot);
  });
});

postgresDescribe('workspace prepare', () => {
  it('rejects source paths outside allowed input roots', async () => {
    const { root, profile, service } = await setup();
    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const outside = path.join(root, 'outside.docx');
    writeFileSync(outside, 'outside');

    await expect(
      service.prepareWorkspaceFiles({
        clientId: 'lqbot',
        profile,
        workspaceId: workspace.workspaceId,
        files: [{ sourcePath: outside, targetPath: 'input/outside.docx' }],
      }),
    ).rejects.toThrow(DaemonError);
  });

  it('copies allowed source files to safe workspace-relative targets', async () => {
    const { uploadsRoot, profile, service } = await setup();
    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const sourcePath = path.join(uploadsRoot, 'source.docx');
    writeFileSync(sourcePath, 'source content');

    const prepared = await service.prepareWorkspaceFiles({
      clientId: 'lqbot',
      profile,
      workspaceId: workspace.workspaceId,
      files: [{ sourcePath, targetPath: 'input/source.docx' }],
    });

    const cwd = getWorkspaceCwd(profile, {
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
    });
    expect(prepared.files).toEqual([{ targetPath: 'input/source.docx', size: 14 }]);
    expect(readFileSync(path.join(cwd, 'input/source.docx'), 'utf8')).toBe('source content');
    expect(JSON.stringify(prepared)).not.toContain(profile.sandboxRoot);
  });

  it('rejects duplicate workspace target paths before copying files concurrently', async () => {
    const { uploadsRoot, profile, service } = await setup();
    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const firstSourcePath = path.join(uploadsRoot, 'first.docx');
    const secondSourcePath = path.join(uploadsRoot, 'second.docx');
    writeFileSync(firstSourcePath, 'first');
    writeFileSync(secondSourcePath, 'second');

    await expect(
      service.prepareWorkspaceFiles({
        clientId: 'lqbot',
        profile,
        workspaceId: workspace.workspaceId,
        files: [
          { sourcePath: firstSourcePath, targetPath: 'input/source.docx' },
          { sourcePath: secondSourcePath, targetPath: 'input/source.docx' },
        ],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it('rejects protected skill staging targets', async () => {
    const { uploadsRoot, profile, service } = await setup();
    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const sourcePath = path.join(uploadsRoot, 'SKILL.md');
    writeFileSync(sourcePath, 'skill');

    await expect(
      service.prepareWorkspaceFiles({
        clientId: 'lqbot',
        profile,
        workspaceId: workspace.workspaceId,
        files: [
          {
            sourcePath,
            targetPath: '.claude-runner-skills/report-writer/SKILL.md',
          },
        ],
      }),
    ).rejects.toThrow(DaemonError);
  });
});

postgresDescribe('workspace uploaded file import', () => {
  it('copies a daemon temp file to input/upload.docx and returns public file metadata', async () => {
    const { root, profile, service } = await setup();
    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const sourcePath = path.join(root, 'upload-tmp', 'upload.docx');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'uploaded content');

    const uploaded = await service.prepareUploadedWorkspaceFile({
      clientId: 'lqbot',
      profile,
      workspaceId: workspace.workspaceId,
      sourcePath,
      targetPath: 'input/upload.docx',
      originalName: 'upload.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const cwd = getWorkspaceCwd(profile, {
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
    });
    expect(uploaded).toEqual({
      workspaceId: 'ws_1',
      workspaceKey: 'lqbot/user_1/project_123',
      file: {
        targetPath: 'input/upload.docx',
        size: 16,
        originalName: 'upload.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    });
    expect(readFileSync(path.join(cwd, 'input/upload.docx'), 'utf8')).toBe('uploaded content');
  });

  it('does not expose temp, workspace, sandbox, or allowed input paths in the response', async () => {
    const { root, profile, service } = await setup();
    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const sourcePath = path.join(root, 'upload-tmp', 'upload.docx');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'uploaded content');

    const uploaded = await service.prepareUploadedWorkspaceFile({
      clientId: 'lqbot',
      profile,
      workspaceId: workspace.workspaceId,
      sourcePath,
      targetPath: 'input/upload.docx',
      originalName: 'upload.docx',
      mimeType: null,
    });

    const cwd = getWorkspaceCwd(profile, {
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
    });
    const responseJson = JSON.stringify(uploaded);
    expect(responseJson).not.toContain(sourcePath);
    expect(responseJson).not.toContain(cwd);
    expect(responseJson).not.toContain(profile.sandboxRoot);
    for (const allowedInputRoot of profile.allowedInputRoots) {
      expect(responseJson).not.toContain(allowedInputRoot);
    }
  });

  it('overwrites an existing file at input/upload.docx', async () => {
    const { root, profile, service } = await setup();
    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const cwd = getWorkspaceCwd(profile, {
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
    });
    writeFileSync(path.join(cwd, 'input/upload.docx'), 'old');
    const sourcePath = path.join(root, 'upload-tmp', 'upload.docx');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'new upload');

    const uploaded = await service.prepareUploadedWorkspaceFile({
      clientId: 'lqbot',
      profile,
      workspaceId: workspace.workspaceId,
      sourcePath,
      targetPath: 'input/upload.docx',
      originalName: 'upload.docx',
      mimeType: null,
    });

    expect(uploaded.file).toEqual({
      targetPath: 'input/upload.docx',
      size: 10,
      originalName: 'upload.docx',
      mimeType: null,
    });
    expect(readFileSync(path.join(cwd, 'input/upload.docx'), 'utf8')).toBe('new upload');
  });

  it('rejects targetPath input when input is an existing directory', async () => {
    const { root, profile, service } = await setup();
    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const sourcePath = path.join(root, 'upload-tmp', 'upload.docx');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'uploaded content');

    await expect(
      service.prepareUploadedWorkspaceFile({
        clientId: 'lqbot',
        profile,
        workspaceId: workspace.workspaceId,
        sourcePath,
        targetPath: 'input',
        originalName: 'upload.docx',
        mimeType: null,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }));
  });

  it('rejects protected skill staging targets', async () => {
    const { root, profile, service } = await setup();
    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const sourcePath = path.join(root, 'upload-tmp', 'upload.docx');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'uploaded content');

    await expect(
      service.prepareUploadedWorkspaceFile({
        clientId: 'lqbot',
        profile,
        workspaceId: workspace.workspaceId,
        sourcePath,
        targetPath: '.claude-runner-skills/upload.docx',
        originalName: 'upload.docx',
        mimeType: null,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }));
  });

  it('returns not found when another client imports into this workspace', async () => {
    const { root, profile, service } = await setup();
    const workspace = await service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const sourcePath = path.join(root, 'upload-tmp', 'upload.docx');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'uploaded content');

    await expect(
      service.prepareUploadedWorkspaceFile({
        clientId: 'another-client',
        profile,
        workspaceId: workspace.workspaceId,
        sourcePath,
        targetPath: 'input/upload.docx',
        originalName: 'upload.docx',
        mimeType: null,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

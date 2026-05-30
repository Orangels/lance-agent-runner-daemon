import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProfileConfig } from '../../config/profiles.js';
import { openInMemoryDatabase } from '../../db/connection.js';
import { applySchema } from '../../db/schema.js';
import { DaemonError } from '../errors.js';
import { createWorkspaceService, getWorkspaceCwd } from '../workspace-service.js';

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
    profileConcurrency: 1,
    runTimeoutMs: 1000,
    inactivityTimeoutMs: 1000,
    cancelGraceMs: 100,
    env: {},
  };
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-workspace-test-'));
  const uploadsRoot = path.join(root, 'uploads');
  mkdirSync(uploadsRoot, { recursive: true });
  const profile = makeProfile(root, uploadsRoot);
  const db = openInMemoryDatabase();
  applySchema(db);
  const service = createWorkspaceService({
    db,
    ids: {
      workspaceId: () => 'ws_1',
    },
    clock: () => 1000,
  });
  return { root, uploadsRoot, profile, service };
}

describe('workspace creation', () => {
  it('creates the workspace directory skeleton', () => {
    const { profile, service } = setup();

    const workspace = service.createOrGetWorkspace({
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

  it('returns the existing workspace id on create-or-get', () => {
    const { profile, service } = setup();

    service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const again = service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });

    expect(again.workspaceId).toBe('ws_1');
  });

  it('does not expose absolute workspace paths in the public response', () => {
    const { profile, service } = setup();

    const workspace = service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });

    expect(JSON.stringify(workspace)).not.toContain(profile.sandboxRoot);
  });
});

describe('workspace prepare', () => {
  it('rejects source paths outside allowed input roots', () => {
    const { root, profile, service } = setup();
    const workspace = service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const outside = path.join(root, 'outside.docx');
    writeFileSync(outside, 'outside');

    expect(() =>
      service.prepareWorkspaceFiles({
        clientId: 'lqbot',
        profile,
        workspaceId: workspace.workspaceId,
        files: [{ sourcePath: outside, targetPath: 'input/outside.docx' }],
      }),
    ).toThrow(DaemonError);
  });

  it('copies allowed source files to safe workspace-relative targets', () => {
    const { uploadsRoot, profile, service } = setup();
    const workspace = service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const sourcePath = path.join(uploadsRoot, 'source.docx');
    writeFileSync(sourcePath, 'source content');

    const prepared = service.prepareWorkspaceFiles({
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

  it('rejects protected skill staging targets', () => {
    const { uploadsRoot, profile, service } = setup();
    const workspace = service.createOrGetWorkspace({
      clientId: 'lqbot',
      profile,
      workspace: { originId: 'lqbot', userId: 'user_1', projectId: 'project_123' },
    });
    const sourcePath = path.join(uploadsRoot, 'SKILL.md');
    writeFileSync(sourcePath, 'skill');

    expect(() =>
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
    ).toThrow(DaemonError);
  });
});

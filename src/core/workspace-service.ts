import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ProfileConfig } from '../config/profiles.js';
import type { PrepareWorkspaceFileRequest, WorkspaceIdentity } from './run-types.js';
import { assertSafePathSegment, assertWorkspaceRelativePath, isPathInsideRoot, resolveUnderRoot } from './path-safety.js';
import { createId } from './ids.js';
import type { RunnerDatabase } from '../db/connection.js';
import {
  getWorkspaceForClient,
  upsertWorkspace,
  type WorkspaceRecord,
} from '../db/repositories.js';
import { daemonError, notFound } from './errors.js';

export interface WorkspaceService {
  createOrGetWorkspace(input: CreateOrGetWorkspaceInput): PublicWorkspace;
  prepareWorkspaceFiles(input: PrepareWorkspaceFilesInput): PreparedWorkspaceFiles;
}

export interface PublicWorkspace {
  workspaceId: string;
  workspaceKey: string;
}

export interface PreparedWorkspaceFiles {
  workspaceId: string;
  workspaceKey: string;
  files: PreparedWorkspaceFile[];
}

export interface PreparedWorkspaceFile {
  targetPath: string;
  size: number;
}

interface CreateOrGetWorkspaceInput {
  clientId: string;
  profile: ProfileConfig;
  workspace: WorkspaceIdentity;
  metadata?: unknown;
}

interface PrepareWorkspaceFilesInput {
  clientId: string;
  isAdmin?: boolean;
  profile: ProfileConfig;
  workspaceId: string;
  files: PrepareWorkspaceFileRequest[];
}

interface WorkspaceServiceDependencies {
  db: RunnerDatabase;
  ids?: {
    workspaceId?: () => string;
  };
  clock?: () => number;
}

export function createWorkspaceService(dependencies: WorkspaceServiceDependencies): WorkspaceService {
  const now = dependencies.clock ?? Date.now;
  const nextWorkspaceId = dependencies.ids?.workspaceId ?? (() => createId('ws'));

  return {
    createOrGetWorkspace(input): PublicWorkspace {
      assertWorkspaceIdentity(input.workspace);
      const workspace = upsertWorkspace(dependencies.db, {
        id: nextWorkspaceId(),
        clientId: input.clientId,
        profileId: input.profile.id,
        originId: input.workspace.originId,
        userId: input.workspace.userId,
        projectId: input.workspace.projectId,
        status: 'active',
        metadata: input.metadata,
        now: now(),
      });

      createWorkspaceSkeleton(input.profile, workspace);

      return toPublicWorkspace(workspace);
    },

    prepareWorkspaceFiles(input): PreparedWorkspaceFiles {
      const workspace = getWorkspaceForClient(dependencies.db, {
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        isAdmin: input.isAdmin,
      });
      if (!workspace) {
        throw notFound('Workspace not found');
      }

      const cwd = getWorkspaceCwd(input.profile, workspace);
      const files = input.files.map((file) => {
        const sourcePath = resolveAllowedSourcePath(input.profile.allowedInputRoots, file.sourcePath);
        const targetPath = assertWorkspaceRelativePath(file.targetPath);
        const targetAbsolutePath = resolveUnderRoot(cwd, targetPath);
        mkdirSync(path.dirname(targetAbsolutePath), { recursive: true });
        copyFileSync(sourcePath, targetAbsolutePath);
        const size = statSync(targetAbsolutePath).size;
        return { targetPath, size };
      });

      return {
        ...toPublicWorkspace(workspace),
        files,
      };
    },
  };
}

export function getWorkspaceCwd(
  profile: ProfileConfig,
  workspace: WorkspaceIdentity | Pick<WorkspaceRecord, 'originId' | 'userId' | 'projectId'>,
): string {
  assertWorkspaceIdentity(workspace);
  return resolveUnderRoot(
    profile.sandboxRoot,
    path.join(workspace.originId, workspace.userId, workspace.projectId),
  );
}

function createWorkspaceSkeleton(profile: ProfileConfig, workspace: WorkspaceRecord): void {
  const cwd = getWorkspaceCwd(profile, workspace);
  for (const directory of ['input', 'output', 'work', '.claude-runner-skills']) {
    mkdirSync(resolveUnderRoot(cwd, directory), { recursive: true });
  }
}

function assertWorkspaceIdentity(workspace: Pick<WorkspaceIdentity, 'originId' | 'userId' | 'projectId'>): void {
  assertSafePathSegment(workspace.originId, 'originId');
  assertSafePathSegment(workspace.userId, 'userId');
  assertSafePathSegment(workspace.projectId, 'projectId');
}

function resolveAllowedSourcePath(allowedInputRoots: readonly string[], sourcePath: string): string {
  const resolvedSourcePath = path.resolve(sourcePath);
  for (const root of allowedInputRoots) {
    if (isPathInsideRoot(root, resolvedSourcePath)) {
      return resolvedSourcePath;
    }
  }

  throw daemonError('PATH_NOT_ALLOWED', 'Source path is not under an allowed input root', 400, {
    sourcePath,
  });
}

function toPublicWorkspace(workspace: WorkspaceRecord): PublicWorkspace {
  return {
    workspaceId: workspace.id,
    workspaceKey: workspace.workspaceKey,
  };
}

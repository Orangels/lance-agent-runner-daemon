import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ProfileConfig } from '../config/profiles.js';
import type { PrepareWorkspaceFileRequest, WorkspaceIdentity } from './run-types.js';
import { assertSafePathSegment, assertWorkspaceRelativePath, isPathInsideRoot, resolveUnderRoot } from './path-safety.js';
import { createId } from './ids.js';
import type { RunnerDatabase } from '../db/connection.js';
import { createSqliteRunnerPersistence } from '../db/sqlite-persistence.js';
import type { RunnerPersistence, WorkspaceRecord } from '../db/types.js';
import { DaemonError, daemonError, notFound } from './errors.js';

export interface WorkspaceService {
  createOrGetWorkspace(input: CreateOrGetWorkspaceInput): Promise<PublicWorkspace>;
  prepareWorkspaceFiles(input: PrepareWorkspaceFilesInput): Promise<PreparedWorkspaceFiles>;
  prepareUploadedWorkspaceFile(input: PrepareUploadedWorkspaceFileInput): Promise<UploadedWorkspaceFileResult>;
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

export interface UploadedWorkspaceFileResult extends PublicWorkspace {
  file: {
    targetPath: string;
    size: number;
    originalName: string;
    mimeType: string | null;
  };
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

interface PrepareUploadedWorkspaceFileInput {
  clientId: string;
  isAdmin?: boolean;
  profile: ProfileConfig;
  workspaceId: string;
  sourcePath: string;
  targetPath: string;
  originalName: string;
  mimeType: string | null;
}

interface WorkspaceServiceDependencies {
  persistence?: RunnerPersistence;
  db?: RunnerDatabase;
  ids?: {
    workspaceId?: () => string;
  };
  clock?: () => number;
}

export function createWorkspaceService(dependencies: WorkspaceServiceDependencies): WorkspaceService {
  const now = dependencies.clock ?? Date.now;
  const nextWorkspaceId = dependencies.ids?.workspaceId ?? (() => createId('ws'));
  const persistence =
    dependencies.persistence ??
    (dependencies.db ? createSqliteRunnerPersistence(dependencies.db) : undefined);
  if (!persistence) {
    throw new Error('WorkspaceService requires persistence');
  }

  return {
    async createOrGetWorkspace(input): Promise<PublicWorkspace> {
      assertWorkspaceIdentity(input.workspace);
      const workspace = await persistence.upsertWorkspace({
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

    async prepareWorkspaceFiles(input): Promise<PreparedWorkspaceFiles> {
      const workspace = await persistence.getWorkspaceForClient({
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
        return copyFileIntoWorkspace({ workspaceCwd: cwd, sourcePath, targetPath: file.targetPath });
      });

      return {
        ...toPublicWorkspace(workspace),
        files,
      };
    },

    async prepareUploadedWorkspaceFile(input): Promise<UploadedWorkspaceFileResult> {
      const workspace = await persistence.getWorkspaceForClient({
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        isAdmin: input.isAdmin,
      });
      if (!workspace) {
        throw notFound('Workspace not found');
      }

      const cwd = getWorkspaceCwd(input.profile, workspace);
      const file = copyFileIntoWorkspace({
        workspaceCwd: cwd,
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
      });

      return {
        ...toPublicWorkspace(workspace),
        file: {
          ...file,
          originalName: input.originalName,
          mimeType: input.mimeType,
        },
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

function copyFileIntoWorkspace(input: {
  workspaceCwd: string;
  sourcePath: string;
  targetPath: string;
}): PreparedWorkspaceFile {
  const targetPath = assertWorkspaceRelativePath(input.targetPath);
  const targetAbsolutePath = resolveUnderRoot(input.workspaceCwd, targetPath);
  try {
    if (statSync(targetAbsolutePath).isDirectory()) {
      throw daemonError('PATH_NOT_ALLOWED', 'Target path cannot be a directory', 400, {
        targetPath,
      });
    }
  } catch (error) {
    if (error instanceof DaemonError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  mkdirSync(path.dirname(targetAbsolutePath), { recursive: true });
  copyFileSync(input.sourcePath, targetAbsolutePath);
  const size = statSync(targetAbsolutePath).size;
  return { targetPath, size };
}

function toPublicWorkspace(workspace: WorkspaceRecord): PublicWorkspace {
  return {
    workspaceId: workspace.id,
    workspaceKey: workspace.workspaceKey,
  };
}

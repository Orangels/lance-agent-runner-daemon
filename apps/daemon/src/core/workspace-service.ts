import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProfileConfig } from '../config/profiles.js';
import type { PrepareWorkspaceFileRequest, WorkspaceIdentity } from './run-types.js';
import { assertSafePathSegment, assertWorkspaceRelativePath, isPathInsideRoot, resolveUnderRoot } from './path-safety.js';
import { createId } from './ids.js';
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
  ids?: {
    workspaceId?: () => string;
  };
  clock?: () => number;
}

export function createWorkspaceService(dependencies: WorkspaceServiceDependencies): WorkspaceService {
  const now = dependencies.clock ?? Date.now;
  const nextWorkspaceId = dependencies.ids?.workspaceId ?? (() => createId('ws'));
  const persistence = dependencies.persistence;
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

      await createWorkspaceSkeleton(input.profile, workspace);

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
      assertNoDuplicateWorkspaceTargets(input.files);
      const files = await Promise.all(
        input.files.map((file) => {
          const sourcePath = resolveAllowedSourcePath(input.profile.allowedInputRoots, file.sourcePath);
          return copyFileIntoWorkspace({ workspaceCwd: cwd, sourcePath, targetPath: file.targetPath });
        }),
      );

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
      const file = await copyFileIntoWorkspace({
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

async function createWorkspaceSkeleton(profile: ProfileConfig, workspace: WorkspaceRecord): Promise<void> {
  const cwd = getWorkspaceCwd(profile, workspace);
  await Promise.all(
    ['input', 'output', 'work', '.claude-runner-skills'].map((directory) =>
      mkdir(resolveUnderRoot(cwd, directory), { recursive: true }),
    ),
  );
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

function assertNoDuplicateWorkspaceTargets(files: readonly { targetPath: string }[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const targetPath = assertWorkspaceRelativePath(file.targetPath);
    if (seen.has(targetPath)) {
      throw daemonError('BAD_REQUEST', 'Duplicate workspace target path', 400, {
        targetPath,
      });
    }
    seen.add(targetPath);
  }
}

async function copyFileIntoWorkspace(input: {
  workspaceCwd: string;
  sourcePath: string;
  targetPath: string;
}): Promise<PreparedWorkspaceFile> {
  const targetPath = assertWorkspaceRelativePath(input.targetPath);
  const targetAbsolutePath = resolveUnderRoot(input.workspaceCwd, targetPath);
  try {
    if ((await stat(targetAbsolutePath)).isDirectory()) {
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

  await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
  await copyFile(input.sourcePath, targetAbsolutePath);
  const size = (await stat(targetAbsolutePath)).size;
  return { targetPath, size };
}

function toPublicWorkspace(workspace: WorkspaceRecord): PublicWorkspace {
  return {
    workspaceId: workspace.id,
    workspaceKey: workspace.workspaceKey,
  };
}

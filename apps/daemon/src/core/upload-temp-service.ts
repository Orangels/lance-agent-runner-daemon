import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { daemonError } from './errors.js';
import { isPathInsideRoot } from './path-safety.js';

export interface UploadTempService {
  getTempRoot(): string;
  createUploadDirectory(): Promise<string>;
  assertTempPath(filePath: string): string;
  removeUploadPath(filePath: string): Promise<void>;
  pruneExpiredUploads(input?: { now?: number }): Promise<{ removed: number }>;
}

interface CreateUploadTempServiceInput {
  config: {
    server: {
      dataDir: string;
      uploadTempRetentionMs: number;
    };
  };
}

export function createUploadTempService(serviceInput: CreateUploadTempServiceInput): UploadTempService {
  const tempRoot = path.resolve(path.join(serviceInput.config.server.dataDir, 'uploads', 'tmp'));

  async function ensureTempRoot(): Promise<void> {
    await mkdir(tempRoot, { recursive: true });
  }

  function assertTempPath(filePath: string): string {
    const resolvedPath = path.resolve(filePath);
    if (!isPathInsideRoot(tempRoot, resolvedPath)) {
      throw daemonError('PATH_NOT_ALLOWED', 'Upload temp path is not allowed', 400);
    }
    return resolvedPath;
  }

  return {
    getTempRoot: () => tempRoot,
    createUploadDirectory: async () => {
      await ensureTempRoot();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const uploadDir = path.join(tempRoot, createUploadDirectoryName());
        try {
          await mkdir(uploadDir);
          return uploadDir;
        } catch (error) {
          if (!isErrnoException(error) || error.code !== 'EEXIST') {
            throw error;
          }
        }
      }
      throw new Error('Unable to create a unique upload directory');
    },
    assertTempPath,
    removeUploadPath: async (filePath) => {
      const resolvedPath = assertTempPath(filePath);
      if (resolvedPath === tempRoot) {
        return;
      }

      await rm(resolvedPath, { recursive: true, force: true });

      const parent = path.dirname(resolvedPath);
      if (parent !== tempRoot && isPathInsideRoot(tempRoot, parent)) {
        try {
          await rmdir(parent);
        } catch (error) {
          if (!isIgnorableRemoveDirectoryError(error)) {
            throw error;
          }
        }
      }
    },
    pruneExpiredUploads: async (input = {}) => {
      await ensureTempRoot();
      const now = input.now ?? Date.now();
      const cutoff = now - serviceInput.config.server.uploadTempRetentionMs;
      let removed = 0;

      for (const entry of await readdir(tempRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }

        const childPath = path.join(tempRoot, entry.name);
        if (childPath === tempRoot || !isPathInsideRoot(tempRoot, childPath)) {
          continue;
        }

        const childStat = await stat(childPath);
        if (childStat.mtimeMs < cutoff) {
          await rm(childPath, { recursive: true, force: true });
          removed += 1;
        }
      }

      return { removed };
    },
  };
}

function createUploadDirectoryName(): string {
  return `upload_${randomUUID().replaceAll('-', '')}`;
}

function isIgnorableRemoveDirectoryError(error: unknown): boolean {
  return (
    isErrnoException(error) &&
    (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'EEXIST')
  );
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

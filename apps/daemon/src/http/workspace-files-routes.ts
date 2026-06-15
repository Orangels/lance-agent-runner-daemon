import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireProfileAccess } from '../config/auth.js';
import { getProfile, type DaemonConfig } from '../config/profiles.js';
import { badRequest, daemonError, type DaemonError, notFound } from '../core/errors.js';
import type { UploadWorkspaceFileResponse } from '../core/run-types.js';
import type { UploadTempService } from '../core/upload-temp-service.js';
import type { WorkspaceService } from '../core/workspace-service.js';
import type { RunnerPersistence } from '../db/types.js';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware.js';
import { workspaceUploadFieldsSchema } from './validation.js';

interface CreateWorkspaceFilesRouterDependencies {
  config: DaemonConfig;
  persistence: RunnerPersistence;
  workspaceService: WorkspaceService;
  uploadTempService: UploadTempService;
}

interface UploadRequest extends AuthenticatedRequest {
  uploadDir?: string;
  file?: Express.Multer.File;
}

export function createWorkspaceFilesRouter(dependencies: CreateWorkspaceFilesRouterDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.config);
  const upload = multer({
    storage: multer.diskStorage({
      destination: (request, _file, callback) => {
        dependencies.uploadTempService
          .createUploadDirectory()
          .then((uploadDir) => {
            (request as UploadRequest).uploadDir = uploadDir;
            callback(null, uploadDir);
          })
          .catch((error: unknown) => {
            callback(error as Error, '');
          });
      },
      filename: (_request, _file, callback) => {
        callback(null, 'file');
      },
    }),
    limits: {
      fileSize: dependencies.config.server.maxUploadBytesPerFile,
      files: 1,
    },
  });

  router.post('/:workspaceId/files', auth, async (request, response, next) => {
    const uploadRequest = request as UploadRequest;

    try {
      try {
        await runUploadMiddleware(upload, uploadRequest, response);
      } catch (error) {
        await cleanupUploadPath(uploadRequest, dependencies.uploadTempService, true);
        throw toUploadDaemonError(error) ?? error;
      }

      let result: UploadWorkspaceFileResponse | undefined;
      let operationError: unknown;
      try {
        const client = uploadRequest.client;
        const fields = workspaceUploadFieldsSchema.parse(uploadRequest.body);
        if (!uploadRequest.file) {
          throw badRequest('Missing upload file');
        }

        const workspaceId = String(uploadRequest.params.workspaceId);
        const workspace = await dependencies.persistence.getWorkspaceForClient({
          workspaceId,
          clientId: client.id,
          isAdmin: client.isAdmin,
        });
        if (!workspace) {
          throw notFound('Workspace not found');
        }

        requireProfileAccess(client, workspace.profileId);
        const profile = getProfile(dependencies.config, workspace.profileId);
        const sourcePath = dependencies.uploadTempService.assertTempPath(uploadRequest.file.path);
        result = await dependencies.workspaceService.prepareUploadedWorkspaceFile({
          clientId: client.id,
          isAdmin: client.isAdmin,
          profile,
          workspaceId: workspace.id,
          sourcePath,
          targetPath: fields.targetPath,
          originalName: uploadRequest.file.originalname,
          mimeType: uploadRequest.file.mimetype || null,
        });
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        await cleanupUploadPath(
          uploadRequest,
          dependencies.uploadTempService,
          operationError !== undefined,
        );
      }

      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function runUploadMiddleware(
  upload: ReturnType<typeof multer>,
  request: Request,
  response: Response,
): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single('file')(request, response, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function toUploadDaemonError(error: unknown): DaemonError | null {
  if (!(error instanceof multer.MulterError)) {
    return null;
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    return daemonError('BAD_REQUEST', 'Uploaded file is too large', 413);
  }

  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return badRequest('Expected exactly one file field named file');
  }

  return null;
}

function cleanupUploadPath(
  request: UploadRequest,
  uploadTempService: UploadTempService,
  suppressErrors: boolean,
): Promise<void> {
  const cleanupPath = request.file?.path ?? request.uploadDir;
  if (!cleanupPath) {
    return Promise.resolve();
  }

  return uploadTempService.removeUploadPath(cleanupPath).catch((error: unknown) => {
    if (!suppressErrors) {
      throw error;
    }
  });
}

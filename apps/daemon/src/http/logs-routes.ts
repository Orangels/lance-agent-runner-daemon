import { createReadStream } from 'node:fs';
import { Router } from 'express';
import type { DaemonConfig } from '../config/profiles.js';
import { badRequest } from '../core/errors.js';
import type { RunLogDownloadKind, RunLogService } from '../core/run-log-service.js';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware.js';
import { buildContentDisposition } from './http-utils.js';

interface CreateLogsRouterDependencies {
  config: DaemonConfig;
  runLogService: RunLogService;
}

export function createLogsRouter(dependencies: CreateLogsRouterDependencies): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(dependencies.config);

  router.get('/', auth, async (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      response.json(
        await dependencies.runLogService.getRunLogs({
          client,
          runId: String(request.params.runId),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/:kind/download', auth, async (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const kind = parseLogDownloadKind(String(request.params.kind));
      const download = await dependencies.runLogService.getRunLogDownload({
        client,
        kind,
        runId: String(request.params.runId),
      });

      response.setHeader('Content-Type', download.mimeType);
      response.setHeader('Content-Length', String(download.size));
      response.setHeader('Content-Disposition', buildContentDisposition(download.fileName));
      createReadStream(download.filePath).on('error', next).pipe(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function parseLogDownloadKind(value: string): RunLogDownloadKind {
  if (value === 'stdout' || value === 'stderr' || value === 'debug-events') {
    return value;
  }
  throw badRequest('Invalid log download kind', { kind: value });
}

import { Router } from 'express';
import type { DaemonConfig } from '../config/profiles.js';
import type { RunLogService } from '../core/run-log-service.js';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware.js';

interface CreateLogsRouterDependencies {
  config: DaemonConfig;
  runLogService: RunLogService;
}

export function createLogsRouter(dependencies: CreateLogsRouterDependencies): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(dependencies.config);

  router.get('/', auth, (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      response.json(
        dependencies.runLogService.getRunLogs({
          client,
          runId: String(request.params.runId),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}

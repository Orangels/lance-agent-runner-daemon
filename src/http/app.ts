import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { DaemonConfig } from '../config/profiles.js';
import { DaemonError, toErrorResponse } from '../core/errors.js';
import type { WorkspaceService } from '../core/workspace-service.js';
import type { RunnerDatabase } from '../db/connection.js';
import { zodErrorToDaemonError } from './validation.js';
import { createHealthRouter } from './health-routes.js';
import { createProfilesRouter } from './profiles-routes.js';
import { createWorkspacesRouter } from './workspaces-routes.js';

interface CreateAppDependencies {
  config: DaemonConfig;
  db: RunnerDatabase;
  workspaceService: WorkspaceService;
}

export function createApp(dependencies: CreateAppDependencies): express.Express {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use('/api/health', createHealthRouter());
  app.use('/api/profiles', createProfilesRouter(dependencies.config));
  app.use(
    '/api/workspaces',
    createWorkspacesRouter({
      config: dependencies.config,
      db: dependencies.db,
      workspaceService: dependencies.workspaceService,
    }),
  );
  app.use(errorHandler);

  return app;
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const daemonError =
    error instanceof ZodError
      ? zodErrorToDaemonError(error)
      : error instanceof DaemonError
        ? error
        : new DaemonError('BAD_REQUEST', error instanceof Error ? error.message : 'Unknown error', 400);

  response.status(daemonError.status).json(toErrorResponse(daemonError));
};

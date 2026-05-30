import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { DaemonConfig } from '../config/profiles.js';
import { DaemonError, badRequest, internalError, toErrorResponse } from '../core/errors.js';
import type { WorkspaceService } from '../core/workspace-service.js';
import type { RunService } from '../core/run-service.js';
import type { RunnerDatabase } from '../db/connection.js';
import { zodErrorToDaemonError } from './validation.js';
import { createHealthRouter } from './health-routes.js';
import { createProfilesRouter } from './profiles-routes.js';
import { createRunsRouter } from './runs-routes.js';
import { createWorkspacesRouter } from './workspaces-routes.js';

interface CreateAppDependencies {
  config: DaemonConfig;
  db: RunnerDatabase;
  workspaceService: WorkspaceService;
  runService?: RunService;
}

export function createApp(dependencies: CreateAppDependencies): express.Express {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use('/api/health', createHealthRouter());
  app.use('/api/profiles', createProfilesRouter(dependencies.config));
  if (dependencies.runService) {
    app.use('/api/runs', createRunsRouter({ config: dependencies.config, runService: dependencies.runService }));
  }
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
        : isHttpClientError(error)
          ? badRequest('Invalid request body')
          : internalError();

  const status = isHttpClientError(error) ? error.status : daemonError.status;
  response.status(status).json(toErrorResponse(daemonError));
};

function isHttpClientError(error: unknown): error is { status: number } {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

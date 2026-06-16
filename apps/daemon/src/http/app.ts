import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { DaemonConfig } from '../config/profiles.js';
import { DaemonError, badRequest, internalError, toErrorResponse } from '../core/errors.js';
import type { WorkspaceService } from '../core/workspace-service.js';
import type { RunService } from '../core/run-service.js';
import type { RunLogService } from '../core/run-log-service.js';
import type { ArtifactService } from '../core/artifact-service.js';
import type { UploadTempService } from '../core/upload-temp-service.js';
import type { ReviewBundleService } from '../core/review-bundle-service.js';
import type { RunFeedbackService } from '../core/run-feedback-service.js';
import type { RunnerPersistence } from '../db/types.js';
import { noopDaemonLogger, type DaemonLogger } from '../core/daemon-logger.js';
import { zodErrorToDaemonError } from './validation.js';
import { createArtifactsRouter } from './artifacts-routes.js';
import { createFeedbackRouter } from './feedback-routes.js';
import { createHealthRouter } from './health-routes.js';
import { createProfilesRouter } from './profiles-routes.js';
import { createLogsRouter } from './logs-routes.js';
import { createReviewBundleRouter } from './review-bundle-routes.js';
import { createRunsRouter } from './runs-routes.js';
import { createWorkspaceFilesRouter } from './workspace-files-routes.js';
import { createWorkspacesRouter } from './workspaces-routes.js';

interface CreateAppDependencies {
  config: DaemonConfig;
  persistence?: RunnerPersistence;
  workspaceService: WorkspaceService;
  runService?: RunService;
  runLogService?: RunLogService;
  artifactService?: ArtifactService;
  uploadTempService?: UploadTempService;
  reviewBundleService?: ReviewBundleService;
  feedbackService?: RunFeedbackService;
  daemonLogger?: DaemonLogger;
}

export function createApp(dependencies: CreateAppDependencies): express.Express {
  const app = express();
  const daemonLogger = dependencies.daemonLogger ?? noopDaemonLogger;
  const persistence = dependencies.persistence;
  if (!persistence) {
    throw new Error('createApp requires persistence');
  }

  app.use(createRequestLogger(daemonLogger));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/health', createHealthRouter());
  app.use('/api/profiles', createProfilesRouter(dependencies.config));
  if (dependencies.artifactService) {
    app.use(
      '/api/runs/:runId/artifacts',
      createArtifactsRouter({
        config: dependencies.config,
        artifactService: dependencies.artifactService,
      }),
    );
  }
  if (dependencies.runLogService) {
    app.use(
      '/api/runs/:runId/logs',
      createLogsRouter({
        config: dependencies.config,
        runLogService: dependencies.runLogService,
      }),
    );
  }
  if (dependencies.reviewBundleService) {
    app.use(
      '/api/runs/:runId/review-bundle',
      createReviewBundleRouter({
        config: dependencies.config,
        reviewBundleService: dependencies.reviewBundleService,
      }),
    );
  }
  if (dependencies.feedbackService) {
    app.use(
      '/api/runs/:runId/feedback',
      createFeedbackRouter({
        config: dependencies.config,
        feedbackService: dependencies.feedbackService,
      }),
    );
  }
  if (dependencies.runService) {
    app.use('/api/runs', createRunsRouter({ config: dependencies.config, runService: dependencies.runService }));
  }
  if (dependencies.uploadTempService) {
    app.use(
      '/api/workspaces',
      createWorkspaceFilesRouter({
        config: dependencies.config,
        persistence,
        workspaceService: dependencies.workspaceService,
        uploadTempService: dependencies.uploadTempService,
      }),
    );
  }
  app.use(
    '/api/workspaces',
    createWorkspacesRouter({
      config: dependencies.config,
      persistence,
      workspaceService: dependencies.workspaceService,
    }),
  );
  app.use(createErrorHandler(daemonLogger));

  return app;
}

function createRequestLogger(daemonLogger: DaemonLogger): express.RequestHandler {
  return (request, response, next) => {
    const startedAt = Date.now();
    response.on('finish', () => {
      daemonLogger.info('http_request', {
        clientId: getRequestClientId(request),
        durationMs: Date.now() - startedAt,
        method: request.method,
        path: request.originalUrl,
        statusCode: response.statusCode,
      });
    });
    next();
  };
}

function createErrorHandler(daemonLogger: DaemonLogger): ErrorRequestHandler {
  return (error, request, response, _next) => {
    const daemonError =
      error instanceof ZodError
        ? zodErrorToDaemonError(error)
        : error instanceof DaemonError
          ? error
          : isHttpClientError(error)
            ? badRequest('Invalid request body')
            : internalError();

    const status = isHttpClientError(error) ? error.status : daemonError.status;
    daemonLogger.error('http_error', {
      clientId: getRequestClientId(request),
      error,
      errorCode: daemonError.code,
      ...errorSummary(error),
      method: request.method,
      path: request.originalUrl,
      statusCode: status,
    });
    response.status(status).json(toErrorResponse(daemonError));
  };
}

function getRequestClientId(request: express.Request): string | null {
  const client = (request as { client?: { id?: unknown } }).client;
  return typeof client?.id === 'string' ? client.id : null;
}

function errorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorName: error.name,
    };
  }
  return {
    errorMessage: String(error),
    errorName: typeof error,
  };
}

function isHttpClientError(error: unknown): error is { status: number } {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

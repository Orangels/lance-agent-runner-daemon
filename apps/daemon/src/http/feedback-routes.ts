import { Router } from 'express';
import type { DaemonConfig } from '../config/profiles.js';
import type { RunFeedbackService } from '../core/run-feedback-service.js';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware.js';
import { createRunFeedbackRequestSchema } from './validation.js';

interface CreateFeedbackRouterDependencies {
  config: DaemonConfig;
  feedbackService: RunFeedbackService;
}

export function createFeedbackRouter(dependencies: CreateFeedbackRouterDependencies): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(dependencies.config);

  router.get('/', auth, (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      response.json({
        feedback: dependencies.feedbackService.listRunFeedback({
          client,
          runId: String(request.params.runId),
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', auth, (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const body = createRunFeedbackRequestSchema.parse(request.body);
      response.status(201).json({
        feedback: dependencies.feedbackService.createRunFeedback({
          client,
          runId: String(request.params.runId),
          category: body.category,
          message: body.message,
          metadata: body.metadata,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

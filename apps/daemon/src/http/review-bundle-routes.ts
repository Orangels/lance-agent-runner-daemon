import { Router } from 'express';
import type { DaemonConfig } from '../config/profiles.js';
import type { ReviewBundleService } from '../core/review-bundle-service.js';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware.js';
import { buildContentDisposition } from './http-utils.js';

interface CreateReviewBundleRouterDependencies {
  config: DaemonConfig;
  reviewBundleService: ReviewBundleService;
}

export function createReviewBundleRouter(dependencies: CreateReviewBundleRouterDependencies): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(dependencies.config);

  router.get('/download', auth, async (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const download = await dependencies.reviewBundleService.createRunReviewBundle({
        client,
        runId: String(request.params.runId),
      });
      response.setHeader('Content-Type', download.mimeType);
      response.setHeader('Content-Length', String(download.size));
      response.setHeader('Content-Disposition', buildContentDisposition(download.fileName));
      response.send(download.buffer);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

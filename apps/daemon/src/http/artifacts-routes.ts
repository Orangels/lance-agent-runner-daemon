import { createReadStream } from 'node:fs';
import { Router } from 'express';
import type { DaemonConfig } from '../config/profiles.js';
import type { ArtifactService } from '../core/artifact-service.js';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware.js';
import { buildContentDisposition } from './http-utils.js';

interface CreateArtifactsRouterDependencies {
  config: DaemonConfig;
  artifactService: ArtifactService;
}

export function createArtifactsRouter(dependencies: CreateArtifactsRouterDependencies): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(dependencies.config);

  router.get('/', auth, (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const runId = String(request.params.runId);
      response.json({
        artifacts: dependencies.artifactService.listRunArtifacts({ client, runId }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:artifactId/download', auth, async (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const download = await dependencies.artifactService.getRunArtifactDownload({
        client,
        runId: String(request.params.runId),
        artifactId: String(request.params.artifactId),
      });

      response.setHeader('Content-Type', download.mimeType ?? 'application/octet-stream');
      if (download.size !== null) {
        response.setHeader('Content-Length', String(download.size));
      }
      response.setHeader('Content-Disposition', buildContentDisposition(download.fileName));

      createReadStream(download.filePath).on('error', next).pipe(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

import { createReadStream } from 'node:fs';
import { Router } from 'express';
import type { DaemonConfig } from '../config/profiles.js';
import type { ArtifactService } from '../core/artifact-service.js';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware.js';

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

function buildContentDisposition(fileName: string): string {
  const fallback = asciiFallbackFileName(fileName);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(fileName)}`;
}

function asciiFallbackFileName(fileName: string): string {
  const extension = pathExtension(fileName);
  const nameWithoutExtension = extension ? fileName.slice(0, -extension.length) : fileName;
  const safeName = nameWithoutExtension
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${safeName || 'artifact'}${extension}`;
}

function pathExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return '';
  }
  const extension = fileName.slice(lastDot).replace(/[^A-Za-z0-9.]/g, '');
  return extension === '.' ? '' : extension;
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

import { Router } from 'express';
import { requireProfileAccess } from '../config/auth.js';
import { getProfile, type DaemonConfig } from '../config/profiles.js';
import type { WorkspaceService } from '../core/workspace-service.js';
import type { RunnerPersistence } from '../db/types.js';
import { notFound } from '../core/errors.js';
import { createWorkspaceRequestSchema, prepareWorkspaceRequestSchema } from './validation.js';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware.js';

interface CreateWorkspacesRouterDependencies {
  config: DaemonConfig;
  persistence: RunnerPersistence;
  workspaceService: WorkspaceService;
}

export function createWorkspacesRouter(dependencies: CreateWorkspacesRouterDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.config);

  router.post('/', auth, async (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const body = createWorkspaceRequestSchema.parse(request.body);
      requireProfileAccess(client, body.profileId);
      const profile = getProfile(dependencies.config, body.profileId);
      const workspace = await dependencies.workspaceService.createOrGetWorkspace({
        clientId: client.id,
        profile,
        workspace: body.workspace,
        metadata: body.metadata,
      });
      response.json(workspace);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:workspaceId/prepare', auth, async (request, response, next) => {
    try {
      const client = (request as AuthenticatedRequest).client;
      const body = prepareWorkspaceRequestSchema.parse(request.body);
      const workspaceId = String(request.params.workspaceId);
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
      response.json(
        await dependencies.workspaceService.prepareWorkspaceFiles({
          clientId: client.id,
          isAdmin: client.isAdmin,
          profile,
          workspaceId: workspace.id,
          files: body.files,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}

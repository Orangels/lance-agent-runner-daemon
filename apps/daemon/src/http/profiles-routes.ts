import { Router } from 'express';
import { filterProfilesForClient } from '../config/auth.js';
import type { DaemonConfig, ProfileConfig } from '../config/profiles.js';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware.js';

export function createProfilesRouter(config: DaemonConfig): Router {
  const router = Router();

  router.get('/', requireAuth(config), (request, response) => {
    const client = (request as AuthenticatedRequest).client;
    response.json({
      profiles: filterProfilesForClient(client, config.profiles).map(toPublicProfile),
    });
  });

  return router;
}

function toPublicProfile(profile: ProfileConfig): Record<string, unknown> {
  return {
    id: profile.id,
    allowedSkillIds: profile.allowedSkillIds,
    artifactRules: profile.artifactRules,
    defaultArtifactRuleIds: profile.defaultArtifactRuleIds,
    defaultModel: profile.defaultModel,
    allowedModels: profile.allowedModels,
    eventVisibility: profile.eventVisibility,
    maxCollectionMode: profile.maxCollectionMode,
    permissionMode: profile.permissionMode,
    profileConcurrency: profile.profileConcurrency,
    runTimeoutMs: profile.runTimeoutMs,
    inactivityTimeoutMs: profile.inactivityTimeoutMs,
    cancelGraceMs: profile.cancelGraceMs,
  };
}

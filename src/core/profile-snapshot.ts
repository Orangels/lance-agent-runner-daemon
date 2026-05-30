import type { ArtifactRuleConfig, ProfileConfig } from '../config/profiles.js';

export interface SanitizedArtifactRuleSnapshot {
  id: string;
  pattern: string;
  role: string;
  required: boolean;
}

export interface SanitizedProfileSnapshot {
  version: 1;
  profileId: string;
  allowedSkillIds: string[];
  artifactRules: SanitizedArtifactRuleSnapshot[];
  defaultArtifactRuleIds: string[];
  permissionMode: ProfileConfig['permissionMode'];
  defaultModel: string;
  allowedModels: string[];
  eventVisibility: ProfileConfig['eventVisibility'];
  profileConcurrency: number;
  runTimeoutMs: number;
  inactivityTimeoutMs: number;
  cancelGraceMs: number;
  envKeys: string[];
  directoryCounts: {
    skillRoots: number;
    allowedInputRoots: number;
  };
}

export function createSanitizedProfileSnapshot(profile: ProfileConfig): SanitizedProfileSnapshot {
  return {
    version: 1,
    profileId: profile.id,
    allowedSkillIds: [...profile.allowedSkillIds],
    artifactRules: profile.artifactRules.map(sanitizeArtifactRule),
    defaultArtifactRuleIds: [...profile.defaultArtifactRuleIds],
    permissionMode: profile.permissionMode,
    defaultModel: profile.defaultModel,
    allowedModels: [...profile.allowedModels],
    eventVisibility: profile.eventVisibility,
    profileConcurrency: profile.profileConcurrency,
    runTimeoutMs: profile.runTimeoutMs,
    inactivityTimeoutMs: profile.inactivityTimeoutMs,
    cancelGraceMs: profile.cancelGraceMs,
    envKeys: Object.keys(profile.env).sort(),
    directoryCounts: {
      skillRoots: profile.skillRoots.length,
      allowedInputRoots: profile.allowedInputRoots.length,
    },
  };
}

function sanitizeArtifactRule(rule: ArtifactRuleConfig): SanitizedArtifactRuleSnapshot {
  return {
    id: rule.id,
    pattern: rule.pattern,
    role: rule.role,
    required: rule.required,
  };
}

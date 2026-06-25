import { z } from 'zod';
import {
  artifactRoles,
  collectionModes,
  eventVisibilityLevels,
  type ArtifactRole,
  type CollectionMode,
  type EventVisibility,
} from '../core/run-types.js';
import { findDisallowedProfileEnvKeys } from './env.js';

export const permissionModes = ['default', 'acceptEdits', 'bypassPermissions'] as const;
export type PermissionMode = (typeof permissionModes)[number];

export interface PersistenceConfig {
  databaseUrl: string;
  poolMax: number;
}

export interface WebhookConfig {
  enabled: boolean;
  allowInsecureHttp: boolean;
  allowPrivateNetworks: boolean;
  allowedPrivateCidrs: string[];
  allowedHosts: string[];
  requestTimeoutMs: number;
  maxAttempts: number;
  lockTimeoutMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  listenReconnectBackoffMs: number;
  listenKeepaliveMs: number;
  listenKeepaliveTimeoutMs: number;
  claimLimit: number;
  maxConcurrentDeliveries: number;
  stopGraceMs: number;
  responseBodyPreviewBytes: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  globalConcurrency: number;
  maxQueueSize: number;
  logRetentionMs: number;
  maxLogBytesPerRun: number;
  runLogCloseTimeoutMs: number;
  maxReviewBundleBytes: number;
  maxUploadBytesPerFile: number;
  uploadTempRetentionMs: number;
  persistence: PersistenceConfig;
  webhooks: WebhookConfig;
}

export interface ClientConfig {
  id: string;
  apiKey: string;
  allowedProfileIds: string[];
  canReadDebugEvents: boolean;
  canReadLogs: boolean;
  isAdmin: boolean;
}

export interface ArtifactRuleConfig {
  id: string;
  pattern: string;
  role: ArtifactRole;
  required: boolean;
}

export interface ProfileConfig {
  id: string;
  sandboxRoot: string;
  claudeConfigDir: string;
  claudeBin: string;
  skillRoots: string[];
  allowedInputRoots: string[];
  allowedSkillIds: string[];
  artifactRules: ArtifactRuleConfig[];
  defaultArtifactRuleIds: string[];
  permissionMode: PermissionMode;
  defaultModel: string;
  allowedModels: string[];
  eventVisibility: EventVisibility;
  maxCollectionMode: CollectionMode;
  profileConcurrency: number;
  runTimeoutMs: number;
  inactivityTimeoutMs: number;
  cancelGraceMs: number;
  env: Record<string, string>;
}

export interface DaemonConfig {
  server: ServerConfig;
  clients: ClientConfig[];
  profiles: ProfileConfig[];
}

interface ParseDaemonConfigOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

const nonEmptyString = z.string().min(1);

const webhookSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z
    .object({
      enabled: z.boolean().default(true),
      allowInsecureHttp: z.boolean().default(true),
      allowPrivateNetworks: z.boolean().default(true),
      allowedPrivateCidrs: z.array(nonEmptyString).default(['192.168.88.0/24']),
      allowedHosts: z.array(nonEmptyString).default([]),
      requestTimeoutMs: z.number().int().min(1).default(5000),
      maxAttempts: z.number().int().min(1).default(8),
      lockTimeoutMs: z.number().int().min(1).default(30000),
      initialBackoffMs: z.number().int().min(0).default(1000),
      maxBackoffMs: z.number().int().min(0).default(300000),
      listenReconnectBackoffMs: z.number().int().min(1).default(1000),
      listenKeepaliveMs: z.number().int().min(1).default(15000),
      listenKeepaliveTimeoutMs: z.number().int().min(1).default(5000),
      claimLimit: z.number().int().min(1).default(5),
      maxConcurrentDeliveries: z.number().int().min(1).default(5),
      stopGraceMs: z.number().int().min(0).default(10000),
      responseBodyPreviewBytes: z.number().int().min(0).default(4096),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.lockTimeoutMs <= value.requestTimeoutMs) {
        context.addIssue({
          code: 'custom',
          message: 'lockTimeoutMs must be greater than requestTimeoutMs',
          path: ['lockTimeoutMs'],
        });
      }
      if (value.listenKeepaliveTimeoutMs > value.listenKeepaliveMs) {
        context.addIssue({
          code: 'custom',
          message: 'listenKeepaliveTimeoutMs must be less than or equal to listenKeepaliveMs',
          path: ['listenKeepaliveTimeoutMs'],
        });
      }
    }),
);

const serverSchema = z
  .object({
    host: nonEmptyString,
    port: z.number().int().min(1).max(65_535),
    dataDir: nonEmptyString,
    globalConcurrency: z.number().int().min(1),
    maxQueueSize: z.number().int().min(0),
    logRetentionMs: z.number().int().min(0).default(7 * 24 * 60 * 60 * 1000),
    maxLogBytesPerRun: z.number().int().min(1).default(4 * 1024 * 1024),
    runLogCloseTimeoutMs: z.number().int().min(0).default(5000),
    maxReviewBundleBytes: z.number().int().min(1).default(16 * 1024 * 1024),
    maxUploadBytesPerFile: z.number().int().min(1).default(50 * 1024 * 1024),
    uploadTempRetentionMs: z.number().int().min(0).default(24 * 60 * 60 * 1000),
    persistence: z
      .object({
        databaseUrl: nonEmptyString,
        poolMax: z.number().int().min(1).default(10),
      })
      .strict(),
    webhooks: webhookSchema,
  })
  .strict();

const clientSchema = z
  .object({
    id: nonEmptyString,
    apiKey: nonEmptyString,
    allowedProfileIds: z.array(nonEmptyString),
    canReadDebugEvents: z.boolean().default(false),
    canReadLogs: z.boolean().default(false),
    isAdmin: z.boolean().default(false),
  })
  .strict();

const artifactRuleSchema = z
  .object({
    id: nonEmptyString,
    pattern: nonEmptyString,
    role: z.enum(artifactRoles),
    required: z.boolean().default(false),
  })
  .strict();

const profileEnvSchema = z
  .record(z.string(), z.string())
  .default({})
  .superRefine((value, context) => {
    for (const key of findDisallowedProfileEnvKeys(value)) {
      context.addIssue({
        code: 'custom',
        message: `Profile env key is not allowed: ${key}`,
        path: [key],
      });
    }
  });

const profileSchema = z
  .object({
    id: nonEmptyString,
    sandboxRoot: nonEmptyString,
    claudeConfigDir: nonEmptyString,
    claudeBin: nonEmptyString.default('claude'),
    skillRoots: z.array(nonEmptyString),
    allowedInputRoots: z.array(nonEmptyString),
    allowedSkillIds: z.array(nonEmptyString),
    artifactRules: z.array(artifactRuleSchema),
    defaultArtifactRuleIds: z.array(nonEmptyString),
    permissionMode: z.enum(permissionModes),
    defaultModel: nonEmptyString,
    allowedModels: z.array(nonEmptyString).min(1),
    eventVisibility: z.enum(eventVisibilityLevels),
    maxCollectionMode: z.enum(collectionModes).default('lite'),
    profileConcurrency: z.number().int().min(1),
    runTimeoutMs: z.number().int().min(1),
    inactivityTimeoutMs: z.number().int().min(1),
    cancelGraceMs: z.number().int().min(0),
    env: profileEnvSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.allowedModels.includes(value.defaultModel)) {
      context.addIssue({
        code: 'custom',
        message: `defaultModel must be included in allowedModels: ${value.defaultModel}`,
        path: ['defaultModel'],
      });
    }

    const artifactRuleIds = new Set(value.artifactRules.map((rule) => rule.id));
    for (const ruleId of value.defaultArtifactRuleIds) {
      if (!artifactRuleIds.has(ruleId)) {
        context.addIssue({
          code: 'custom',
          message: `defaultArtifactRuleIds contains unknown rule: ${ruleId}`,
          path: ['defaultArtifactRuleIds'],
        });
      }
    }
  });

const rawDaemonConfigSchema = z
  .object({
    server: serverSchema,
    clients: z.array(clientSchema).min(1),
    profiles: z.array(profileSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const profileIds = new Set(value.profiles.map((profile) => profile.id));
    for (const client of value.clients) {
      for (const profileId of client.allowedProfileIds) {
        if (!profileIds.has(profileId)) {
          context.addIssue({
            code: 'custom',
            message: `client ${client.id} references unknown profile: ${profileId}`,
            path: ['clients'],
          });
        }
      }
    }
  });

export function parseDaemonConfig(
  rawConfig: unknown,
  options: ParseDaemonConfigOptions = {},
): DaemonConfig {
  const parsed = rawDaemonConfigSchema.parse(rawConfig);
  const env = options.env ?? process.env;

  return {
    ...parsed,
    server: {
      ...parsed.server,
      persistence: {
        databaseUrl: resolveConfigEnvReference(
          parsed.server.persistence.databaseUrl,
          env,
          'databaseUrl',
        ),
        poolMax: parsed.server.persistence.poolMax,
      },
    },
    clients: parsed.clients.map((client) => ({
      ...client,
      apiKey: resolveConfigEnvReference(client.apiKey, env, 'secret'),
    })),
  };
}

export function getProfile(config: DaemonConfig, profileId: string): ProfileConfig {
  const profile = config.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  return profile;
}

export function isModelAllowed(profile: ProfileConfig, model: string): boolean {
  return profile.allowedModels.includes(model);
}

function resolveConfigEnvReference(
  value: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  label: 'databaseUrl' | 'secret',
): string {
  if (!value.startsWith('env:')) {
    return value;
  }

  const key = value.slice('env:'.length);
  if (!key) {
    throw new Error(`env: ${label} reference is missing a variable name`);
  }

  const resolved = env[key];
  if (!resolved) {
    throw new Error(`Missing required environment variable for ${label}: ${key}`);
  }

  return resolved;
}

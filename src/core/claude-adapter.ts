import type { ProfileConfig } from '../config/profiles.js';
import type { ClaudeCapabilities } from './claude-capabilities.js';
import { daemonError } from './errors.js';

export interface BuildClaudeInvocationInput {
  profile: ProfileConfig;
  prompt: string;
  workspaceCwd: string;
  extraAllowedDirs?: string[];
  requestModel?: string;
  capabilities?: ClaudeCapabilities;
  baseEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface ClaudeInvocation {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdinPrompt: string;
}

export function buildClaudeInvocation(input: BuildClaudeInvocationInput): ClaudeInvocation {
  const model = selectModel(input.profile, input.requestModel);
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];

  if (input.capabilities?.partialMessages === true) {
    args.push('--include-partial-messages');
  }

  args.push('--model', model);

  const extraAllowedDirs = (input.extraAllowedDirs ?? []).filter((dir) => dir.length > 0);
  if (extraAllowedDirs.length > 0 && input.capabilities?.addDir !== false) {
    args.push('--add-dir', input.workspaceCwd, ...extraAllowedDirs);
  }

  args.push('--permission-mode', input.profile.permissionMode);

  return {
    bin: input.profile.claudeBin,
    args,
    cwd: input.workspaceCwd,
    env: {
      ...sanitizeBaseEnv(input.baseEnv ?? process.env),
      ...input.profile.env,
      CLAUDE_CONFIG_DIR: input.profile.claudeConfigDir,
    },
    stdinPrompt: input.prompt,
  };
}

function sanitizeBaseEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith('LANCE_DESIGN_')) {
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

function selectModel(profile: ProfileConfig, requestModel: string | undefined): string {
  if (!requestModel) {
    return profile.defaultModel;
  }

  if (profile.allowedModels.includes(requestModel)) {
    return requestModel;
  }

  throw daemonError('MODEL_NOT_ALLOWED', `Model is not allowed for profile ${profile.id}`, 400, {
    model: requestModel,
    profileId: profile.id,
  });
}

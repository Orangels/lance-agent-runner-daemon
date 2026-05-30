export const profileEnvAllowlist = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'DISABLE_AUTOUPDATER',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_BUG_COMMAND',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
] as const;

export type ProfileEnvKey = (typeof profileEnvAllowlist)[number];

const profileEnvAllowlistSet = new Set<string>(profileEnvAllowlist);

export function isAllowedProfileEnvKey(key: string): key is ProfileEnvKey {
  return profileEnvAllowlistSet.has(key);
}

export function findDisallowedProfileEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => !isAllowedProfileEnvKey(key));
}

import { readFileSync } from 'node:fs';
import { parseDaemonConfig, type DaemonConfig } from './profiles.js';

export function loadDaemonConfig(
  configPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DaemonConfig {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  return parseDaemonConfig(raw, { env });
}

export function getConfigPathFromArgs(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  const configFlagIndex = argv.indexOf('--config');
  if (configFlagIndex >= 0) {
    return argv[configFlagIndex + 1];
  }
  return env.CLAUDE_RUNNER_CONFIG;
}

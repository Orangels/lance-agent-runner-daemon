import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDaemonConfig, type DaemonConfig } from './profiles.js';

export function loadDaemonConfig(
  configPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DaemonConfig {
  const resolvedConfigPath = path.resolve(configPath);
  const raw = JSON.parse(readFileSync(resolvedConfigPath, 'utf8')) as unknown;
  return normalizeDaemonConfigPaths(
    parseDaemonConfig(raw, { env }),
    path.dirname(resolvedConfigPath),
  );
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

function normalizeDaemonConfigPaths(config: DaemonConfig, baseDir: string): DaemonConfig {
  return {
    ...config,
    server: {
      ...config.server,
      dataDir: resolveConfigPath(baseDir, config.server.dataDir),
    },
    profiles: config.profiles.map((profile) => ({
      ...profile,
      sandboxRoot: resolveConfigPath(baseDir, profile.sandboxRoot),
      claudeConfigDir: resolveConfigPath(baseDir, profile.claudeConfigDir),
      skillRoots: profile.skillRoots.map((root) => resolveConfigPath(baseDir, root)),
      allowedInputRoots: profile.allowedInputRoots.map((root) => resolveConfigPath(baseDir, root)),
    })),
  };
}

function resolveConfigPath(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

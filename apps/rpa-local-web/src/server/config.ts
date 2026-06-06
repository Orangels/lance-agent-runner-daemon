import path from 'node:path';

export interface RpaLocalServerConfig {
  host: string;
  port: number;
  daemonBaseUrl: string;
  daemonApiKey: string;
  defaultProfileId: string;
  storageRoot: string;
  mode: 'development' | 'production' | 'test';
}

export function readRpaLocalServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): RpaLocalServerConfig {
  return {
    host: env.RPA_LOCAL_HOST ?? '127.0.0.1',
    port: parsePort(env.RPA_LOCAL_PORT ?? '5174'),
    daemonBaseUrl: env.RPA_DAEMON_BASE_URL ?? 'http://127.0.0.1:17890',
    daemonApiKey: env.RPA_DAEMON_API_KEY ?? 'local-dev-key',
    defaultProfileId: env.RPA_DAEMON_PROFILE_ID ?? 'rpa-local',
    storageRoot: path.resolve(env.RPA_LOCAL_STORAGE_ROOT ?? '.rpa-local'),
    mode: env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development',
  };
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid RPA_LOCAL_PORT: ${value}`);
  }
  return parsed;
}

import path from 'node:path';

export interface RpaLocalServerConfig {
  host: string;
  port: number;
  daemonBaseUrl: string;
  daemonApiKey: string;
  defaultProfileId: string;
  storageRoot: string;
  codegenCommand: string;
  codegenArgs: string[];
  codegenStartTimeoutMs?: number;
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
    codegenCommand: env.RPA_CODEGEN_COMMAND ?? 'playwright',
    codegenArgs: parseCodegenArgs(env.RPA_CODEGEN_ARGS_JSON),
    codegenStartTimeoutMs: parseOptionalPositiveInteger(
      env.RPA_CODEGEN_START_TIMEOUT_MS,
      'RPA_CODEGEN_START_TIMEOUT_MS',
    ),
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

function parseCodegenArgs(value: string | undefined): string[] {
  if (value === undefined) return ['codegen'];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to the structured config error below.
  }

  throw new Error('Invalid RPA_CODEGEN_ARGS_JSON: expected JSON string array');
}

function parseOptionalPositiveInteger(value: string | undefined, envName: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid ${envName}: expected positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${envName}: expected positive integer`);
  }

  return parsed;
}

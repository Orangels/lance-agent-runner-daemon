import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

type LogData = Record<string, unknown>;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DaemonLogger {
  debug(event: string, data?: LogData): void;
  info(event: string, data?: LogData): void;
  warn(event: string, data?: LogData): void;
  error(event: string, data?: LogData): void;
}

export const noopDaemonLogger: DaemonLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface CreateDaemonLoggerInput {
  dataDir: string;
  now?: () => number;
}

export function createDaemonLogger(input: CreateDaemonLoggerInput): DaemonLogger {
  const now = input.now ?? Date.now;
  const logDir = path.join(input.dataDir, 'logs');
  const serviceLogPath = path.join(logDir, 'daemon.log');
  const errorLogPath = path.join(logDir, 'daemon-error.log');

  const write = (level: LogLevel, event: string, data: LogData = {}) => {
    try {
      mkdirSync(logDir, { recursive: true });
      const line = JSON.stringify(createLogRecord({ data, event, level, time: now() })) + '\n';
      appendFileSync(serviceLogPath, line, 'utf8');
      if (level === 'warn' || level === 'error') {
        appendFileSync(errorLogPath, line, 'utf8');
      }
    } catch (error) {
      reportLogWriteFailure(error);
    }
  };

  return {
    debug: (event, data) => write('debug', event, data),
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
  };
}

function reportLogWriteFailure(error: unknown): void {
  try {
    console.error('Failed to write daemon service log:', error instanceof Error ? error.message : String(error));
  } catch {
    // Never let the logging fallback affect request or runner control flow.
  }
}

function createLogRecord(input: { data: LogData; event: string; level: LogLevel; time: number }): LogData {
  const { error, ...rest } = input.data;
  const sanitized = sanitizeValue(rest);
  return {
    event: input.event,
    level: input.level,
    time: input.time,
    ...(isPlainObject(sanitized) ? sanitized : {}),
    ...serializeError(error),
  };
}

function serializeError(error: unknown): LogData {
  if (!error) {
    return {};
  }
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorName: error.name,
      errorStack: error.stack,
    };
  }
  return {
    errorMessage: String(error),
    errorName: typeof error,
  };
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = isSecretKey(key) ? '[redacted]' : sanitizeValue(nestedValue, seen);
  }
  return output;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized.includes('apikey') ||
    normalized.includes('authorization') ||
    normalized.includes('bearer') ||
    normalized.includes('cookie') ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('token')
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

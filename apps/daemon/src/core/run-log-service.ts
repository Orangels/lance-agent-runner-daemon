import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from '../config/profiles.js';
import type { RunnerPersistence, RunLogRecord } from '../db/types.js';
import { forbidden, notFound } from './errors.js';
import { sanitizeLogText } from './log-sanitizer.js';
import { isPathInsideRoot } from './path-safety.js';
import type { RunEvent } from './run-events.js';

export interface RunLogClient {
  id: string;
  isAdmin?: boolean;
  canReadDebugEvents?: boolean;
  canReadLogs: boolean;
}

export interface RunLogHandle {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  debugEvent(event: RunEvent): void;
  close(): Promise<void>;
}

export interface PublicRunLogSummary {
  available: boolean;
  size: number;
  tail: string;
}

export interface PublicRunLogs {
  runId: string;
  logs: {
    stdout: PublicRunLogSummary;
    stderr: PublicRunLogSummary;
    debugEvents: PublicRunLogSummary;
  };
}

export type RunLogDownloadKind = 'stdout' | 'stderr' | 'debug-events';

export interface RunLogDownload {
  filePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface RunLogService {
  readonly dataDir: string;
  openRunLogs(input: { runId: string }): Promise<RunLogHandle>;
  getRunLogs(input: { runId: string; client: RunLogClient }): Promise<PublicRunLogs>;
  getRunLogDownload(input: {
    runId: string;
    kind: RunLogDownloadKind;
    client: RunLogClient;
  }): Promise<RunLogDownload>;
  pruneExpiredLogs(input: { now: number }): Promise<{ pruned: number }>;
}

interface CreateRunLogServiceInput {
  persistence?: RunnerPersistence;
  config: { server: ServerConfig };
  clock?: () => number;
}

const logTailBytes = 16 * 1024;
const truncationMarker = '\n[truncated: max log bytes reached]\n';

export function createRunLogService(input: CreateRunLogServiceInput): RunLogService {
  const dataDir = path.resolve(input.config.server.dataDir);
  const logRoot = path.join(dataDir, 'logs', 'runs');
  const now = input.clock ?? Date.now;
  const persistence = input.persistence;
  if (!persistence) {
    throw new Error('RunLogService requires persistence');
  }

  return {
    dataDir,
    openRunLogs: async ({ runId }) => {
      const runDirRelative = path.join('logs', 'runs', runId);
      const runDir = resolveInsideDataDir(dataDir, runDirRelative);
      await mkdir(runDir, { recursive: true });

      const stdoutLogPath = path.join(runDirRelative, 'stdout.log');
      const stderrLogPath = path.join(runDirRelative, 'stderr.log');
      const debugEventsLogPath = path.join(runDirRelative, 'debug-events.ndjson');
      const stdout = createBoundedWriter(dataDir, stdoutLogPath, input.config.server.maxLogBytesPerRun);
      const stderr = createBoundedWriter(dataDir, stderrLogPath, input.config.server.maxLogBytesPerRun);
      const debugEvents = createBoundedWriter(
        dataDir,
        debugEventsLogPath,
        input.config.server.maxLogBytesPerRun,
      );
      await Promise.all([stdout.open(), stderr.open(), debugEvents.open()]);

      await persistence.upsertRunLogPaths({
        runId,
        stdoutLogPath,
        stderrLogPath,
        debugEventsLogPath,
        now: now(),
      });

      return {
        stdout: (chunk) => stdout.append(sanitizeLogText(chunk)),
        stderr: (chunk) => stderr.append(sanitizeLogText(chunk)),
        debugEvent: (event) => debugEvents.append(`${sanitizeLogText(JSON.stringify(event))}\n`),
        close: async () => {
          const results = await Promise.allSettled([
            stdout.close(),
            stderr.close(),
            debugEvents.close(),
          ]);
          const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (rejected) {
            throw rejected.reason;
          }
        },
      };
    },
    getRunLogs: async ({ runId, client }) => {
      if (!client.canReadLogs) {
        throw forbidden('Client is not allowed to read run logs');
      }

      const run = await persistence.getRunForClient({
        runId,
        clientId: client.id,
        isAdmin: client.isAdmin,
      });
      if (!run) {
        throw notFound('Run not found');
      }

      const record = await persistence.getRunLogForRunForClient({
        runId,
        clientId: client.id,
        isAdmin: client.isAdmin,
      });

      const [stdout, stderr, debugEvents] = await Promise.all([
        summarizeLogFile(dataDir, record?.stdoutLogPath ?? null),
        summarizeLogFile(dataDir, record?.stderrLogPath ?? null),
        summarizeLogFile(dataDir, record?.debugEventsLogPath ?? null),
      ]);

      return {
        runId,
        logs: {
          stdout,
          stderr,
          debugEvents,
        },
      };
    },
    getRunLogDownload: async ({ runId, kind, client }) => {
      if (kind === 'debug-events') {
        if (!client.canReadDebugEvents) {
          throw forbidden('Client is not allowed to read debug run logs');
        }
      } else if (!client.canReadLogs) {
        throw forbidden('Client is not allowed to read run logs');
      }

      const record = await persistence.getRunLogForRunForClient({
        runId,
        clientId: client.id,
        isAdmin: client.isAdmin,
      });
      if (!record) {
        throw notFound('Run log not found');
      }

      const relativePath = logPathForKind(record, kind);
      if (relativePath === null) {
        throw notFound('Run log not found');
      }
      const absolutePath = resolveInsideDataDir(dataDir, relativePath);
      const safeStat = await stat(absolutePath).catch(() => null);
      if (!safeStat?.isFile()) {
        throw notFound('Run log not found');
      }

      return {
        filePath: absolutePath,
        fileName: fileNameForKind(kind),
        mimeType: 'text/plain; charset=utf-8',
        size: safeStat.size,
      };
    },
    pruneExpiredLogs: async ({ now: pruneNow }) => {
      const cutoff = pruneNow - input.config.server.logRetentionMs;
      const expired = await persistence.listRunLogsFinishedBefore({
        finishedBefore: cutoff,
        limit: 500,
      });

      for (const record of expired) {
        const runDir = path.join(logRoot, record.runId);
        if (isPathInsideRoot(dataDir, runDir)) {
          await rm(runDir, { recursive: true, force: true });
        }
      }

      return { pruned: await persistence.deleteRunLogRows(expired.map((record) => record.runId)) };
    },
  };
}

function logPathForKind(record: RunLogRecord, kind: RunLogDownloadKind): string | null {
  switch (kind) {
    case 'stdout':
      return record.stdoutLogPath;
    case 'stderr':
      return record.stderrLogPath;
    case 'debug-events':
      return record.debugEventsLogPath;
  }
}

function fileNameForKind(kind: RunLogDownloadKind): string {
  return kind === 'debug-events' ? 'debug-events.ndjson' : `${kind}.log`;
}

function createBoundedWriter(dataDir: string, relativePath: string, maxBytes: number) {
  const absolutePath = resolveInsideDataDir(dataDir, relativePath);
  let bytes = 0;
  let truncated = false;
  let queue = Promise.resolve();
  let failure: unknown = null;

  const enqueue = (operation: () => Promise<void>) => {
    queue = queue.then(operation).catch((error) => {
      failure = error;
    });
  };

  return {
    async open(): Promise<void> {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, '');
    },
    append: (text: string) => {
      if (truncated) return;

      const buffer = Buffer.from(text, 'utf8');
      enqueue(async () => {
        if (truncated) return;

        const availableBytes = maxBytes - bytes;
        if (buffer.byteLength <= availableBytes) {
          await writeFile(absolutePath, buffer, { flag: 'a' });
          bytes += buffer.byteLength;
          return;
        }

        if (availableBytes > 0) {
          await writeFile(absolutePath, buffer.subarray(0, availableBytes), { flag: 'a' });
          bytes += availableBytes;
        }
        await writeFile(absolutePath, truncationMarker, { flag: 'a' });
        truncated = true;
      });
    },
    async close(): Promise<void> {
      await queue;
      if (failure) {
        throw failure;
      }
    },
  };
}

async function summarizeLogFile(dataDir: string, relativePath: string | null): Promise<PublicRunLogSummary> {
  if (relativePath === null) {
    return unavailableLog();
  }

  const absolutePath = resolveInsideDataDir(dataDir, relativePath);
  const safeStat = await stat(absolutePath).catch(() => null);
  if (!safeStat?.isFile()) {
    return unavailableLog();
  }

  const content = await readFile(absolutePath);
  const tail = content.subarray(Math.max(0, content.byteLength - logTailBytes)).toString('utf8');
  return {
    available: true,
    size: safeStat.size,
    tail,
  };
}

function unavailableLog(): PublicRunLogSummary {
  return { available: false, size: 0, tail: '' };
}

function resolveInsideDataDir(dataDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error('Run log path must be relative to dataDir');
  }

  const resolved = path.resolve(dataDir, relativePath);
  if (!isPathInsideRoot(dataDir, resolved)) {
    throw new Error('Run log path escapes dataDir');
  }
  return resolved;
}

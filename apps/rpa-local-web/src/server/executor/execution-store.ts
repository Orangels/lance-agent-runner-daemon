import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isTerminalExecutionEvent,
} from './execution-events.js';
import type {
  CreateExecutionInput,
  FinishExecutionInput,
  RpaExecutionEvent,
  RpaExecutionParamSummaryValue,
  RpaExecutionRecord,
} from './execution-types.js';

export interface FileExecutionStoreOptions {
  storageRoot: string;
  idFactory?: () => string;
}

export interface ExecutionLogs {
  executionId: string;
  stdout: string;
  stderr: string;
}

interface LiveSubscriber {
  queue: RpaExecutionEvent[];
  closed: boolean;
  waiters: Array<() => void>;
}

export interface FileExecutionStore {
  createExecution(input: CreateExecutionInput): Promise<RpaExecutionRecord>;
  markRunning(executionId: string): Promise<RpaExecutionRecord>;
  appendEvent(event: RpaExecutionEvent): Promise<RpaExecutionEvent>;
  appendLog(executionId: string, stream: 'stdout' | 'stderr', message: string): Promise<RpaExecutionEvent>;
  finishExecution(executionId: string, terminal: FinishExecutionInput): Promise<RpaExecutionRecord>;
  getExecution(executionId: string): Promise<RpaExecutionRecord>;
  getLogs(executionId: string): Promise<ExecutionLogs>;
  subscribe(executionId: string): AsyncIterable<RpaExecutionEvent>;
}

export function createFileExecutionStore(options: FileExecutionStoreOptions): FileExecutionStore {
  const storageRoot = path.resolve(options.storageRoot);
  const idFactory = options.idFactory ?? (() => `exec_${randomUUID().replaceAll('-', '').slice(0, 16)}`);
  const subscribers = new Map<string, Set<LiveSubscriber>>();
  const nextSequences = new Map<string, number>();

  function executionDir(executionId: string): string {
    if (!/^exec_[a-zA-Z0-9_]+$/.test(executionId)) {
      throw new Error(`Invalid execution id: ${executionId}`);
    }
    const resolved = path.resolve(storageRoot, 'executions', executionId);
    const root = path.resolve(storageRoot, 'executions');
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Unsafe execution path: ${executionId}`);
    }
    return resolved;
  }

  async function ensureExecutionDirs(executionId: string): Promise<string> {
    const dir = executionDir(executionId);
    await mkdir(path.join(dir, 'logs'), { recursive: true });
    await mkdir(path.join(dir, 'artifacts'), { recursive: true });
    return dir;
  }

  async function writeExecution(record: RpaExecutionRecord): Promise<void> {
    const dir = executionDir(record.executionId);
    const target = path.join(dir, 'execution.json');
    const temp = path.join(dir, `execution.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(temp, target);
  }

  async function readEvents(executionId: string): Promise<RpaExecutionEvent[]> {
    try {
      const content = await readFile(path.join(executionDir(executionId), 'events.jsonl'), 'utf8');
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as RpaExecutionEvent);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function allocateSequence(executionId: string): Promise<number> {
    const existing = nextSequences.get(executionId);
    if (existing !== undefined) {
      nextSequences.set(executionId, existing + 1);
      return existing;
    }
    const events = await readEvents(executionId);
    const next = Math.max(0, ...events.map((event) => event.sequence ?? 0)) + 1;
    nextSequences.set(executionId, next + 1);
    return next;
  }

  function publish(executionId: string, event: RpaExecutionEvent): void {
    const liveSubscribers = subscribers.get(executionId);
    if (!liveSubscribers) return;
    for (const subscriber of liveSubscribers) {
      subscriber.queue.push(event);
      if (isTerminalExecutionEvent(event)) subscriber.closed = true;
      for (const waiter of subscriber.waiters.splice(0)) waiter();
    }
  }

  async function nextLiveEvent(subscriber: LiveSubscriber): Promise<RpaExecutionEvent | undefined> {
    while (subscriber.queue.length === 0 && !subscriber.closed) {
      await new Promise<void>((resolve) => subscriber.waiters.push(resolve));
    }
    return subscriber.queue.shift();
  }

  function addSubscriber(executionId: string): LiveSubscriber {
    const subscriber: LiveSubscriber = { queue: [], closed: false, waiters: [] };
    const existing = subscribers.get(executionId);
    if (existing) {
      existing.add(subscriber);
    } else {
      subscribers.set(executionId, new Set([subscriber]));
    }
    return subscriber;
  }

  function removeSubscriber(executionId: string, subscriber: LiveSubscriber): void {
    const existing = subscribers.get(executionId);
    if (!existing) return;
    existing.delete(subscriber);
    if (existing.size === 0) subscribers.delete(executionId);
  }

  return {
    async createExecution(input) {
      const executionId = idFactory();
      const dir = await ensureExecutionDirs(executionId);
      const now = new Date().toISOString();
      const masked = new Set(input.maskedParamIds);
      const paramsSummary: Record<string, RpaExecutionParamSummaryValue> = {};
      for (const [key, value] of Object.entries(input.params)) {
        paramsSummary[key] = masked.has(key) ? '[masked]' : value;
      }
      const record: RpaExecutionRecord = {
        executionId,
        flowId: input.flowId,
        daemonRunId: input.daemonRunId,
        mode: input.mode,
        dryRun: input.dryRun,
        headless: input.headless,
        status: 'queued',
        createdAt: now,
        timeoutMs: input.timeoutMs,
        paramsSummary,
      };
      await writeFile(path.join(dir, 'run.params.json'), `${JSON.stringify(input.params, null, 2)}\n`, 'utf8');
      await writeExecution(record);
      return record;
    },

    async markRunning(executionId) {
      const record = await this.getExecution(executionId);
      const updated: RpaExecutionRecord = {
        ...record,
        status: 'running',
        startedAt: record.startedAt ?? new Date().toISOString(),
      };
      await writeExecution(updated);
      return updated;
    },

    async appendEvent(event) {
      const withSequence: RpaExecutionEvent = {
        ...event,
        timestamp: event.timestamp || new Date().toISOString(),
        sequence: event.sequence ?? (await allocateSequence(event.executionId)),
      };
      await appendFile(
        path.join(executionDir(withSequence.executionId), 'events.jsonl'),
        `${JSON.stringify(withSequence)}\n`,
        'utf8',
      );
      publish(withSequence.executionId, withSequence);
      return withSequence;
    },

    async appendLog(executionId, stream, message) {
      const sanitized = sanitizeForStorageRoot(message, storageRoot);
      await appendFile(path.join(executionDir(executionId), 'logs', `${stream}.log`), `${sanitized}\n`, 'utf8');
      return this.appendEvent({
        type: 'log',
        executionId,
        timestamp: new Date().toISOString(),
        stream,
        message: sanitized,
      });
    },

    async finishExecution(executionId, terminal) {
      const record = await this.getExecution(executionId);
      const finishedAt = new Date().toISOString();
      const updated: RpaExecutionRecord = {
        ...record,
        status: terminal.status,
        failedStepId: terminal.failedStepId,
        error: terminal.error
          ? {
              code: terminal.error.code,
              message: sanitizeForStorageRoot(terminal.error.message, storageRoot),
            }
          : undefined,
        finishedAt,
      };
      await writeExecution(updated);
      await this.appendEvent({
        type: 'run.completed',
        executionId,
        timestamp: finishedAt,
        status: terminal.status,
        exitCode: terminal.exitCode,
      });
      return updated;
    },

    async getExecution(executionId) {
      return JSON.parse(await readFile(path.join(executionDir(executionId), 'execution.json'), 'utf8')) as RpaExecutionRecord;
    },

    async getLogs(executionId) {
      const dir = executionDir(executionId);
      const [stdout, stderr] = await Promise.all([
        readOptionalText(path.join(dir, 'logs', 'stdout.log')),
        readOptionalText(path.join(dir, 'logs', 'stderr.log')),
      ]);
      return { executionId, stdout, stderr };
    },

    async *subscribe(executionId) {
      const subscriber = addSubscriber(executionId);
      const sentSequences = new Set<number>();
      try {
        const history = await readEvents(executionId);
        for (const event of history) {
          if (event.sequence !== undefined) sentSequences.add(event.sequence);
          yield event;
          if (isTerminalExecutionEvent(event)) return;
        }

        while (true) {
          const event = await nextLiveEvent(subscriber);
          if (!event) return;
          if (event.sequence !== undefined && sentSequences.has(event.sequence)) {
            if (isTerminalExecutionEvent(event)) return;
            continue;
          }
          if (event.sequence !== undefined) sentSequences.add(event.sequence);
          yield event;
          if (isTerminalExecutionEvent(event)) return;
        }
      } finally {
        removeSubscriber(executionId, subscriber);
      }
    },
  };
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return '';
    throw error;
  }
}

function sanitizeForStorageRoot(value: string, storageRoot: string): string {
  return value.split(storageRoot).join('[rpa-storage]');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

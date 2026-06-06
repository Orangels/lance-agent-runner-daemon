import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface PlaywrightCodegenLogEntry {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface PlaywrightCodegenRunnerOptions {
  command: string;
  args?: string[];
  storageRoot: string;
  maxLogLineBytes?: number;
  maxTotalLogBytes?: number;
  spawnProcess?: SpawnProcess;
}

export interface PlaywrightCodegenStartInput {
  scriptPath: string;
  targetUrl: string;
  appendLog?: (entry: PlaywrightCodegenLogEntry) => void;
}

export interface PlaywrightCodegenHandle {
  done: Promise<PlaywrightCodegenResult>;
  cancel: () => void;
}

export interface PlaywrightCodegenResult {
  status: 'completed' | 'cancelled';
  scriptPath: string;
}

export class PlaywrightCodegenRunnerError extends Error {
  readonly code: string;
  readonly publicMessage: string;

  constructor(code: string, publicMessage: string) {
    super(publicMessage);
    this.name = 'PlaywrightCodegenRunnerError';
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

interface SpawnOptions {
  shell: false;
}

interface ChildStream {
  setEncoding: (encoding: BufferEncoding) => void;
  on: (event: 'data', listener: (chunk: string | Buffer) => void) => unknown;
}

interface ChildProcessLike {
  stdout?: ChildStream | null;
  stderr?: ChildStream | null;
  once: {
    (event: 'error', listener: (error: Error) => void): unknown;
    (event: 'close', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown;
  };
  kill: (signal?: NodeJS.Signals) => boolean;
}

export type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;

const DEFAULT_MAX_LOG_LINE_BYTES = 4_000;
const DEFAULT_MAX_TOTAL_LOG_BYTES = 64_000;
const CANCEL_GRACE_MS = 250;
const REDACTED_STORAGE_ROOT = '[rpa-storage]';

export function createPlaywrightCodegenRunner(
  options: PlaywrightCodegenRunnerOptions,
): { start: (input: PlaywrightCodegenStartInput) => PlaywrightCodegenHandle } {
  const command = options.command;
  const baseArgs = options.args ?? [];
  const storageRoot = path.resolve(options.storageRoot);
  const spawnProcess = options.spawnProcess ?? (spawn as SpawnProcess);
  const maxLogLineBytes = options.maxLogLineBytes ?? DEFAULT_MAX_LOG_LINE_BYTES;
  const maxTotalLogBytes = options.maxTotalLogBytes ?? DEFAULT_MAX_TOTAL_LOG_BYTES;

  return {
    start(input) {
      let child: ChildProcessLike | undefined;
      let cancelled = false;
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const done = run().finally(() => {
        if (killTimer) {
          clearTimeout(killTimer);
        }
      });

      async function run(): Promise<PlaywrightCodegenResult> {
        validateHttpTargetUrl(input.targetUrl, storageRoot);
        await mkdir(path.dirname(input.scriptPath), { recursive: true });

        const appendLog = createBoundedLogAppender({
          appendLog: input.appendLog,
          storageRoot,
          maxLogLineBytes,
          maxTotalLogBytes,
        });
        const stdout = createLineBuffer((line) => appendLog('stdout', line));
        const stderr = createLineBuffer((line) => appendLog('stderr', line));
        const args = [...baseArgs, '--target', 'python', '-o', input.scriptPath, input.targetUrl];

        const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            try {
              child = spawnProcess(command, args, { shell: false });
            } catch (error) {
              reject(toRunnerError('CODEGEN_SPAWN_FAILED', error, storageRoot));
              return;
            }

            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');
            child.stdout?.on('data', stdout.append);
            child.stderr?.on('data', stderr.append);

            child.once('error', (error) => {
              reject(toRunnerError('CODEGEN_SPAWN_FAILED', error, storageRoot));
            });
            child.once('close', (exitCode, signal) => {
              closed = true;
              stdout.flush();
              stderr.flush();
              resolve({ exitCode, signal });
            });

            if (cancelled) {
              terminateChild();
            }
          },
        );

        if (cancelled) {
          return { status: 'cancelled', scriptPath: input.scriptPath };
        }

        if (result.exitCode !== 0) {
          throw new PlaywrightCodegenRunnerError(
            'CODEGEN_PROCESS_FAILED',
            redactLocalPaths(
              `Playwright codegen exited with code ${result.exitCode ?? 'null'}${result.signal ? ` (${result.signal})` : ''}.`,
              storageRoot,
            ),
          );
        }

        await assertNonEmptyScript(input.scriptPath, storageRoot);
        return { status: 'completed', scriptPath: input.scriptPath };
      }

      function terminateChild(): void {
        cancelled = true;
        if (!child || closed) {
          return;
        }
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!closed) {
            child?.kill('SIGKILL');
          }
        }, CANCEL_GRACE_MS);
      }

      return {
        done,
        cancel: terminateChild,
      };
    },
  };
}

async function assertNonEmptyScript(scriptPath: string, storageRoot: string): Promise<void> {
  try {
    const stats = await stat(scriptPath);
    if (stats.isFile() && stats.size > 0) {
      return;
    }
  } catch {
    // Fall through to the public, redacted error below.
  }

  throw new PlaywrightCodegenRunnerError(
    'CODEGEN_OUTPUT_MISSING',
    redactLocalPaths(`Playwright codegen did not produce a non-empty script at ${scriptPath}.`, storageRoot),
  );
}

function validateHttpTargetUrl(targetUrl: string, storageRoot: string): void {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new PlaywrightCodegenRunnerError('INVALID_TARGET_URL', 'Target URL must be a valid http or https URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PlaywrightCodegenRunnerError('INVALID_TARGET_URL', 'Target URL must be a valid http or https URL.');
  }

  if (targetUrl.includes(storageRoot)) {
    throw new PlaywrightCodegenRunnerError(
      'INVALID_TARGET_URL',
      redactLocalPaths('Target URL must not include a local storage path.', storageRoot),
    );
  }
}

function toRunnerError(code: string, error: unknown, storageRoot: string): PlaywrightCodegenRunnerError {
  const message = error instanceof Error ? error.message : String(error);
  return new PlaywrightCodegenRunnerError(code, redactLocalPaths(message, storageRoot));
}

function redactLocalPaths(value: string, storageRoot: string): string {
  return value.split(storageRoot).join(REDACTED_STORAGE_ROOT);
}

function createBoundedLogAppender(input: {
  appendLog?: (entry: PlaywrightCodegenLogEntry) => void;
  storageRoot: string;
  maxLogLineBytes: number;
  maxTotalLogBytes: number;
}): (stream: 'stdout' | 'stderr', line: string) => void {
  let totalBytes = 0;

  return (stream, rawLine) => {
    if (!input.appendLog || totalBytes >= input.maxTotalLogBytes) {
      return;
    }

    const redacted = redactLocalPaths(rawLine, input.storageRoot);
    const line = truncateByCodeUnits(redacted, input.maxLogLineBytes);
    const remainingBytes = input.maxTotalLogBytes - totalBytes;
    const limitedLine = truncateByCodeUnits(line, remainingBytes);
    totalBytes += limitedLine.length;
    input.appendLog({ stream, line: limitedLine });
  };
}

function truncateByCodeUnits(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 15) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - 15)}...[truncated]`;
}

interface LineBuffer {
  append: (chunk: string | Buffer) => void;
  flush: () => void;
}

function createLineBuffer(onLine: (line: string) => void): LineBuffer {
  let buffered = '';

  return {
    append(chunk): void {
      buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      for (const part of parts) {
        onLine(stripTrailingCarriageReturn(part));
      }
    },
    flush(): void {
      if (buffered.length === 0) {
        return;
      }
      onLine(stripTrailingCarriageReturn(buffered));
      buffered = '';
    },
  };
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

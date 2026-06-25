import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { ClaudeInvocation } from './claude-adapter.js';
import { diagnoseClaudeCliFailure } from './claude-diagnostics.js';
import { createClaudeStreamHandler } from './claude-stream.js';
import { sanitizeLogText } from './log-sanitizer.js';
import { capRawEventLine, type RunEvent, type RunEventSink } from './run-events.js';
import type { DaemonErrorCode, RunStatus } from './run-types.js';

export interface CliReadableStream extends Pick<EventEmitter, 'on'> {
  setEncoding?(encoding: BufferEncoding): void;
}

export interface CliWritableStream extends Pick<EventEmitter, 'on'> {
  end(chunk?: string | Uint8Array, encoding?: BufferEncoding): unknown;
}

export interface CliChildProcess extends Pick<EventEmitter, 'on' | 'once'> {
  stdout: CliReadableStream;
  stderr: CliReadableStream;
  stdin?: CliWritableStream | null;
  kill(signal?: NodeJS.Signals | string): boolean;
}

export interface ClaudeSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  stdio: ['pipe', 'pipe', 'pipe'];
  shell: false;
}

export type SpawnClaudeProcess = (
  bin: string,
  args: string[],
  options: ClaudeSpawnOptions,
) => CliChildProcess;

export interface CliRunnerTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timerId: unknown): void;
}

export interface CliRunnerLogSink {
  stdout?(chunk: string): void;
  stderr?(chunk: string): void;
  debugEvent?(event: RunEvent): void;
}

export interface StartClaudeCliRunInput {
  invocation: ClaudeInvocation;
  inactivityTimeoutMs: number;
  cancelGraceMs: number;
  onEvent: RunEventSink;
  logSink?: CliRunnerLogSink;
  spawn?: SpawnClaudeProcess;
  timer?: CliRunnerTimer;
}

export interface ClaudeCliRunResult {
  status: RunStatus;
  exitCode: number | null;
  signal: string | null;
  errorCode?: DaemonErrorCode;
  errorMessage?: string;
  errorDetails?: unknown;
  stdoutTail: string;
  stderrTail: string;
}

export interface ClaudeCliRunHandle {
  completed: Promise<ClaudeCliRunResult>;
  cancel(): void;
}

const defaultTimer: CliRunnerTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timerId) => clearTimeout(timerId as ReturnType<typeof setTimeout>),
};

const defaultSpawn: SpawnClaudeProcess = (bin, args, options) =>
  nodeSpawn(bin, args, options) as unknown as CliChildProcess;

export function startClaudeCliRun(input: StartClaudeCliRunInput): ClaudeCliRunHandle {
  const spawn = input.spawn ?? defaultSpawn;
  const timer = input.timer ?? defaultTimer;
  const invocation = input.invocation;

  let child: CliChildProcess | null = null;
  let childClosed = false;
  let completed = false;
  let cancelRequested = false;
  let inactivityTimer: unknown = null;
  let killTimer: unknown = null;
  let stdoutTail = '';
  let stderrTail = '';

  let resolveCompleted: (result: ClaudeCliRunResult) => void;
  const completedPromise = new Promise<ClaudeCliRunResult>((resolve) => {
    resolveCompleted = resolve;
  });

  const clearInactivityWatchdog = () => {
    if (inactivityTimer !== null) {
      timer.clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
  };

  const clearKillTimer = () => {
    if (killTimer !== null) {
      timer.clearTimeout(killTimer);
      killTimer = null;
    }
  };

  const complete = (result: Omit<ClaudeCliRunResult, 'stdoutTail' | 'stderrTail'>) => {
    if (completed) return;
    completed = true;
    clearInactivityWatchdog();
    resolveCompleted({
      ...result,
      stdoutTail,
      stderrTail,
    });
  };

  const emitDiagnosticError = (
    code: Extract<DaemonErrorCode, 'CLAUDE_AUTH_FAILED' | 'CLAUDE_CLI_FAILED'>,
    message: string,
    details: unknown,
  ) => {
    emitEvent({ type: 'error', code, message, details });
  };

  const emitLogSinkError = () => {
    input.onEvent({ type: 'stderr', text: 'Run log sink failed.' });
  };

  const writeLogSink = (write: (() => void) | undefined) => {
    if (!write) return;
    try {
      write();
    } catch {
      emitLogSinkError();
    }
  };

  const emitEvent = (event: RunEvent) => {
    input.onEvent(event);
    writeLogSink(() => input.logSink?.debugEvent?.(event));
  };

  const failWithDiagnostic = (failure: {
    exitCode?: number | null;
    signal?: string | null;
    spawnError?: unknown;
  }) => {
    const diagnostic = diagnoseClaudeCliFailure({
      exitCode: failure.exitCode,
      signal: failure.signal,
      stderr: stderrTail,
      stdout: stdoutTail,
      spawnError: failure.spawnError,
    });
    const safeDiagnostic =
      diagnostic ??
      ({
        code: 'CLAUDE_CLI_FAILED',
        message: 'Claude CLI failed.',
        details: { category: 'unknown' },
      } as const);

    emitDiagnosticError(safeDiagnostic.code, safeDiagnostic.message, safeDiagnostic.details);
    complete({
      status: 'failed',
      exitCode: failure.exitCode ?? null,
      signal: failure.signal ?? null,
      errorCode: safeDiagnostic.code,
      errorMessage: safeDiagnostic.message,
      errorDetails: safeDiagnostic.details,
    });
  };

  const scheduleKillEscalation = () => {
    if (!child || childClosed || killTimer !== null) return;

    killTimer = timer.setTimeout(() => {
      killTimer = null;
      if (!childClosed) {
        child?.kill('SIGKILL');
      }
    }, input.cancelGraceMs);
  };

  const terminateChild = () => {
    if (!child || childClosed) return;
    child.kill('SIGTERM');
    scheduleKillEscalation();
  };

  const failForInactivity = () => {
    if (completed || cancelRequested) return;

    const code = 'RUN_INACTIVITY_TIMEOUT';
    const message = 'Claude CLI produced no output before the inactivity timeout.';
    const details = { category: 'timeout' };
    emitEvent({ type: 'error', code, message, details });
    complete({
      status: 'failed',
      exitCode: null,
      signal: null,
      errorCode: code,
      errorMessage: message,
      errorDetails: details,
    });
    terminateChild();
  };

  const noteActivity = () => {
    if (completed || cancelRequested || input.inactivityTimeoutMs <= 0) return;

    clearInactivityWatchdog();
    inactivityTimer = timer.setTimeout(failForInactivity, input.inactivityTimeoutMs);
  };

  try {
    child = spawn(invocation.bin, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    failWithDiagnostic({ exitCode: 1, signal: null, spawnError: error });
    return {
      completed: completedPromise,
      cancel: () => {},
    };
  }

  child.stdout.setEncoding?.('utf8');
  child.stderr.setEncoding?.('utf8');

  const claudeStream = createClaudeStreamHandler((event) => {
    noteActivity();
    emitEvent(sanitizeDebugEvent(event));
  });

  child.stdout.on('data', (chunk: unknown) => {
    const text = String(chunk);
    noteActivity();
    stdoutTail = `${stdoutTail}${text}`.slice(-2_000);
    writeLogSink(() => input.logSink?.stdout?.(sanitizeLogText(text)));
    claudeStream.feed(text);
  });

  child.stderr.on('data', (chunk: unknown) => {
    const text = String(chunk);
    noteActivity();
    stderrTail = `${stderrTail}${text}`.slice(-2_000);
    writeLogSink(() => input.logSink?.stderr?.(sanitizeLogText(text)));
    emitEvent({ type: 'stderr', text: sanitizeLogText(capRawEventLine(text)) });
  });

  child.on('error', (error: unknown) => {
    if (completed) return;
    failWithDiagnostic({ exitCode: 1, signal: null, spawnError: error });
    terminateChild();
  });

  child.on('close', (code: number | null, signal: NodeJS.Signals | string | null) => {
    childClosed = true;
    clearInactivityWatchdog();
    clearKillTimer();
    claudeStream.flush();

    if (completed) return;

    const normalizedSignal = signal === null ? null : String(signal);
    if (cancelRequested) {
      complete({
        status: 'canceled',
        exitCode: code,
        signal: normalizedSignal,
      });
      return;
    }

    if (code === 0) {
      complete({
        status: 'succeeded',
        exitCode: code,
        signal: normalizedSignal,
      });
      return;
    }

    failWithDiagnostic({ exitCode: code, signal: normalizedSignal });
  });

  if (child.stdin) {
    child.stdin.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'EPIPE' || completed) return;

      failWithDiagnostic({ exitCode: 1, signal: null, spawnError: error });
      terminateChild();
    });
    child.stdin.end(invocation.stdinPrompt, 'utf8');
  }

  noteActivity();

  return {
    completed: completedPromise,
    cancel: () => {
      if (completed || cancelRequested) return;
      cancelRequested = true;
      clearInactivityWatchdog();
      terminateChild();
    },
  };
}

function sanitizeDebugEvent(event: RunEvent): RunEvent {
  if (event.type === 'stderr') {
    return { ...event, text: sanitizeLogText(event.text) };
  }

  if (event.type === 'raw') {
    return { ...event, line: sanitizeLogText(event.line) };
  }

  return event;
}

import { spawn } from 'node:child_process';

const CANCEL_GRACE_MS = 250;

export interface ManagedProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface ManagedProcessHandle {
  done: Promise<ManagedProcessResult>;
  cancel: () => void;
}

export interface ManagedProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  canceled: boolean;
  timedOut: boolean;
}

interface LineBuffer {
  append: (chunk: string) => void;
  flush: () => void;
}

export function startManagedProcess(options: ManagedProcessOptions): ManagedProcessHandle {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
  });

  let canceled = false;
  let timedOut = false;
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const stdout = createLineBuffer(options.onStdoutLine);
  const stderr = createLineBuffer(options.onStderrLine);

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', stdout.append);
  child.stderr?.on('data', stderr.append);

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminateChild();
  }, options.timeoutMs);

  const done = new Promise<ManagedProcessResult>((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });

    child.once('close', (exitCode, signal) => {
      closed = true;
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      stdout.flush();
      stderr.flush();
      resolve({
        exitCode,
        signal,
        canceled,
        timedOut,
      });
    });
  });

  function terminateChild(): void {
    if (closed || canceled) {
      return;
    }

    canceled = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!closed) {
        child.kill('SIGKILL');
      }
    }, CANCEL_GRACE_MS);
  }

  return {
    done,
    cancel: terminateChild,
  };
}

function createLineBuffer(onLine?: (line: string) => void): LineBuffer {
  let buffered = '';

  return {
    append(chunk: string): void {
      buffered += chunk;
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';

      for (const part of parts) {
        onLine?.(stripTrailingCarriageReturn(part));
      }
    },

    flush(): void {
      if (buffered.length === 0) {
        return;
      }

      onLine?.(stripTrailingCarriageReturn(buffered));
      buffered = '';
    },
  };
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ClaudeInvocation } from '../claude-adapter.js';
import {
  startClaudeCliRun,
  type CliChildProcess,
  type CliRunnerLogSink,
  type SpawnClaudeProcess,
} from '../cli-runner.js';
import type { RunEvent } from '../run-events.js';

function makeInvocation(overrides: Partial<ClaudeInvocation> = {}): ClaudeInvocation {
  return {
    bin: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose'],
    cwd: '/tmp/workspace/work',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/tmp/claude' },
    stdinPrompt: 'Revise the report.',
    ...overrides,
  };
}

class FakeReadable extends EventEmitter {
  setEncoding(_encoding: BufferEncoding): void {}

  emitData(chunk: string): void {
    this.emit('data', chunk);
  }
}

class FakeStdin extends EventEmitter {
  chunks: string[] = [];
  ended = false;

  end(chunk?: string | Uint8Array, _encoding?: BufferEncoding): this {
    if (chunk !== undefined) {
      this.chunks.push(String(chunk));
    }
    this.ended = true;
    this.emit('finish');
    return this;
  }

  emitError(error: Error & { code?: string }): void {
    this.emit('error', error);
  }
}

class FakeChild extends EventEmitter implements CliChildProcess {
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  stdin = new FakeStdin();
  kills: string[] = [];

  kill(signal?: NodeJS.Signals | string): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }
}

function createSpawnHarness(options: { throwOnSpawn?: unknown } = {}) {
  const child = new FakeChild();
  const calls: Array<{ bin: string; args: string[]; options: Parameters<SpawnClaudeProcess>[2] }> = [];
  const spawn: SpawnClaudeProcess = (bin, args, spawnOptions) => {
    if (options.throwOnSpawn) {
      throw options.throwOnSpawn;
    }
    calls.push({ bin, args, options: spawnOptions });
    return child;
  };

  return { child, calls, spawn };
}

function createTimerHarness() {
  let nextId = 1;
  const timers: Array<{ id: number; delayMs: number; callback: () => void; cleared: boolean }> = [];

  return {
    timer: {
      setTimeout: (callback: () => void, delayMs: number) => {
        const task = { id: nextId++, delayMs, callback, cleared: false };
        timers.push(task);
        return task.id;
      },
      clearTimeout: (id: number) => {
        const timer = timers.find((task) => task.id === id);
        if (timer) timer.cleared = true;
      },
    },
    pendingTimers: () => timers.filter((task) => !task.cleared),
    runNextTimer: () => {
      const task = timers.find((candidate) => !candidate.cleared);
      if (!task) throw new Error('No pending timer');
      task.cleared = true;
      task.callback();
      return task;
    },
  };
}

function startHarness(
  input: { invocation?: ClaudeInvocation; throwOnSpawn?: unknown; logSink?: CliRunnerLogSink } = {},
) {
  const events: RunEvent[] = [];
  const spawnHarness = createSpawnHarness({ throwOnSpawn: input.throwOnSpawn });
  const timerHarness = createTimerHarness();
  const run = startClaudeCliRun({
    invocation: input.invocation ?? makeInvocation(),
    inactivityTimeoutMs: 10_000,
    cancelGraceMs: 500,
    spawn: spawnHarness.spawn,
    timer: timerHarness.timer,
    onEvent: (event) => events.push(event),
    logSink: input.logSink,
  });

  return { ...spawnHarness, ...timerHarness, events, run };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('startClaudeCliRun', () => {
  it('emits parsed agent events from fake stdout JSONL', async () => {
    const harness = startHarness();

    harness.child.stdout.emitData(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
      }),
    );
    harness.child.close(0);

    await expect(harness.run.completed).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(harness.events).toEqual([{ type: 'text_delta', delta: 'hello' }]);
  });

  it('writes prompt to stdin and never passes prompt in argv', () => {
    const invocation = makeInvocation({ stdinPrompt: 'Prompt that stays off argv.' });
    const harness = startHarness({ invocation });

    expect(harness.child.stdin.chunks).toEqual(['Prompt that stays off argv.']);
    expect(harness.child.stdin.ended).toBe(true);
    expect(harness.calls[0]).toMatchObject({
      bin: 'claude',
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      options: { cwd: '/tmp/workspace/work', env: invocation.env, shell: false },
    });
    expect(harness.calls[0]?.args.join('\0')).not.toContain('Prompt that stays off argv.');
  });

  it('ignores stdin EPIPE and lets the close handler decide the result', async () => {
    const harness = startHarness();

    harness.child.stdin.emitError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    harness.child.close(0);

    await expect(harness.run.completed).resolves.toMatchObject({ status: 'succeeded' });
    expect(harness.events).toEqual([]);
  });

  it('fails the run for non-EPIPE stdin errors without exposing the raw message', async () => {
    const harness = startHarness();

    harness.child.stdin.emitError(Object.assign(new Error('write /tmp/workspace/work/secret failed'), { code: 'EIO' }));

    await expect(harness.run.completed).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'CLAUDE_CLI_FAILED',
    });
    expect(harness.events).toEqual([
      {
        type: 'error',
        code: 'CLAUDE_CLI_FAILED',
        message: 'Claude CLI failed.',
        details: { category: 'spawn' },
      },
    ]);
    expect(JSON.stringify(harness.events)).not.toContain('/tmp/workspace');
  });

  it('maps spawn errors to CLAUDE_CLI_FAILED', async () => {
    const harness = startHarness({ throwOnSpawn: new Error('spawn /tmp/claude ENOENT') });

    await expect(harness.run.completed).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'CLAUDE_CLI_FAILED',
    });
    expect(harness.events).toEqual([
      {
        type: 'error',
        code: 'CLAUDE_CLI_FAILED',
        message: 'Claude CLI failed.',
        details: { category: 'spawn' },
      },
    ]);
    expect(JSON.stringify(harness.events)).not.toContain('/tmp/claude');
  });

  it('fails non-zero closes with generic diagnostics and no raw stderr', async () => {
    const harness = startHarness();

    harness.child.stderr.emitData('401 unauthorized token=secret CLAUDE_CONFIG_DIR=/tmp/claude');
    harness.child.close(1);

    await expect(harness.run.completed).resolves.toMatchObject({
      status: 'failed',
      exitCode: 1,
      errorCode: 'CLAUDE_AUTH_FAILED',
    });
    expect(harness.events.at(-1)).toEqual({
      type: 'error',
      code: 'CLAUDE_AUTH_FAILED',
      message: 'Claude CLI authentication failed.',
      details: { category: 'auth' },
    });
    expect(JSON.stringify(harness.events)).not.toContain('token=secret');
    expect(JSON.stringify(harness.events)).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('cancel sends SIGTERM and escalates to SIGKILL after cancelGraceMs if the child stays alive', async () => {
    const harness = startHarness();

    harness.run.cancel();
    expect(harness.child.kills).toEqual(['SIGTERM']);
    expect(harness.pendingTimers().some((timer) => timer.delayMs === 500)).toBe(true);

    harness.runNextTimer();
    expect(harness.child.kills).toEqual(['SIGTERM', 'SIGKILL']);

    harness.child.close(null, 'SIGTERM');
    await expect(harness.run.completed).resolves.toMatchObject({
      status: 'canceled',
      exitCode: null,
      signal: 'SIGTERM',
    });
  });

  it('caps stdout and stderr tails retained for diagnostics', async () => {
    const harness = startHarness();
    const hugeStdout = 'o'.repeat(2_500);
    const hugeStderr = 'e'.repeat(2_500);

    harness.child.stdout.emitData(hugeStdout);
    harness.child.stderr.emitData(hugeStderr);
    harness.child.close(1);

    const result = await harness.run.completed;
    expect(result.stdoutTail).toHaveLength(2_000);
    expect(result.stderrTail).toHaveLength(2_000);
    expect(result.stdoutTail).toBe(hugeStdout.slice(-2_000));
    expect(result.stderrTail).toBe(hugeStderr.slice(-2_000));
  });

  it('fails inactive runs with RUN_INACTIVITY_TIMEOUT and terminates the child', async () => {
    const harness = startHarness();

    const inactivityTimer = harness.runNextTimer();
    expect(inactivityTimer.delayMs).toBe(10_000);

    await expect(harness.run.completed).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'RUN_INACTIVITY_TIMEOUT',
    });
    expect(harness.events).toEqual([
      {
        type: 'error',
        code: 'RUN_INACTIVITY_TIMEOUT',
        message: 'Claude CLI produced no output before the inactivity timeout.',
        details: { category: 'timeout' },
      },
    ]);
    expect(harness.child.kills).toEqual(['SIGTERM']);

    harness.runNextTimer();
    expect(harness.child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not let inactivity overwrite terminal or cancel state', async () => {
    const finished = startHarness();
    finished.child.close(0);
    await expect(finished.run.completed).resolves.toMatchObject({ status: 'succeeded' });
    expect(finished.pendingTimers()).toEqual([]);

    const canceled = startHarness();
    canceled.run.cancel();
    canceled.runNextTimer();
    expect(canceled.events).toEqual([]);
  });

  it('writes sanitized stdout and stderr chunks to the log sink', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const harness = startHarness({
      logSink: {
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
      },
    });

    harness.child.stdout.emitData('raw stdout /tmp/workspace/secret.txt output/report.docx\n');
    harness.child.stderr.emitData('token=secret CLAUDE_CONFIG_DIR=/tmp/claude');
    harness.child.close(0);

    await expect(harness.run.completed).resolves.toMatchObject({ status: 'succeeded' });
    expect(stdout.join('')).toContain('[redacted-path]');
    expect(stdout.join('')).toContain('output/report.docx');
    expect(stderr.join('')).not.toContain('token=secret');
    expect(stderr.join('')).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('writes sanitized debug events to the log sink', async () => {
    const debugEvents: RunEvent[] = [];
    const harness = startHarness({
      logSink: {
        debugEvent: (event) => debugEvents.push(event),
      },
    });

    harness.child.stdout.emitData('not-json /tmp/workspace/secret.txt\n');
    harness.child.close(0);

    await expect(harness.run.completed).resolves.toMatchObject({ status: 'succeeded' });
    expect(debugEvents).toEqual([{ type: 'raw', line: 'not-json [redacted-path]' }]);
  });

  it('continues the run when a log sink throws', async () => {
    const harness = startHarness({
      logSink: {
        stdout: () => {
          throw new Error('sink failed /tmp/secret');
        },
      },
    });

    harness.child.stdout.emitData(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
      }),
    );
    harness.child.close(0);

    await expect(harness.run.completed).resolves.toMatchObject({ status: 'succeeded' });
    expect(harness.events).toContainEqual({ type: 'stderr', text: 'Run log sink failed.' });
    expect(JSON.stringify(harness.events)).not.toContain('/tmp/secret');
  });
});

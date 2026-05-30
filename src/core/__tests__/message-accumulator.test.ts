import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMessageFlushPolicy, type RunStatus } from '../run-types.js';
import type { RunEvent } from '../run-events.js';

const updateRunMessage = vi.fn();
const updateAssistantMessageStarted = vi.fn();
const updateAssistantMessageTerminal = vi.fn();

vi.mock('../../db/repositories.js', () => ({
  updateRunMessage,
  updateAssistantMessageStarted,
  updateAssistantMessageTerminal,
}));

const { createMessageAccumulator } = await import('../message-accumulator.js');

type TimerTask = {
  id: number;
  delayMs: number;
  callback: () => void;
  cleared: boolean;
};

function createDeterministicRuntime(startNow = 1_000) {
  let nextTimerId = 1;
  let now = startNow;
  const tasks: TimerTask[] = [];

  return {
    clock: {
      now: () => now,
    },
    timer: {
      setTimeout: (callback: () => void, delayMs: number) => {
        const task = { id: nextTimerId++, delayMs, callback, cleared: false };
        tasks.push(task);
        return task.id;
      },
      clearTimeout: (id: number) => {
        const task = tasks.find((candidate) => candidate.id === id);
        if (task) task.cleared = true;
      },
    },
    advanceTo: (nextNow: number) => {
      now = nextNow;
    },
    runNextTimer: () => {
      const task = tasks.find((candidate) => !candidate.cleared);
      if (!task) throw new Error('No pending timer');
      task.cleared = true;
      task.callback();
      return task;
    },
    pendingTimers: () => tasks.filter((task) => !task.cleared),
  };
}

function createAccumulator(input?: { messageId?: string; startNow?: number }) {
  const runtime = createDeterministicRuntime(input?.startNow);
  const db = { label: input?.messageId ?? 'db' };
  const accumulator = createMessageAccumulator({
    db,
    messageId: input?.messageId ?? 'message-1',
    clock: runtime.clock,
    timer: runtime.timer,
  });

  return { accumulator, db, runtime };
}

describe('message accumulator', () => {
  beforeEach(() => {
    updateRunMessage.mockReset();
    updateAssistantMessageStarted.mockReset();
    updateAssistantMessageTerminal.mockReset();
  });

  it('marks the assistant message running with startedAt when the run starts', () => {
    const { accumulator, db, runtime } = createAccumulator({ messageId: 'assistant-1' });

    accumulator.startRun({ startedAt: 1_234 });

    expect(updateAssistantMessageStarted).toHaveBeenCalledWith(db, {
      messageId: 'assistant-1',
      startedAt: 1_234,
      now: runtime.clock.now(),
    });
  });

  it('appends text_delta events to assistant content on flush', () => {
    const { accumulator, db, runtime } = createAccumulator({ messageId: 'assistant-1' });

    accumulator.consume({ type: 'text_delta', delta: 'hello ' }, '1');
    accumulator.consume({ type: 'text_delta', delta: 'world' }, '2');
    accumulator.forceFlush();

    expect(updateRunMessage).toHaveBeenCalledTimes(1);
    expect(updateRunMessage).toHaveBeenCalledWith(db, {
      messageId: 'assistant-1',
      content: 'hello world',
      events: [
        { type: 'text_delta', delta: 'hello ' },
        { type: 'text_delta', delta: 'world' },
      ],
      lastRunEventId: '2',
      now: runtime.clock.now(),
    });
  });

  it('appends status, thinking, tool, usage, error, and end events to events_json', () => {
    const { accumulator, db, runtime } = createAccumulator();
    const events: RunEvent[] = [
      { type: 'status', label: 'initializing', model: 'claude-sonnet-4-5' },
      { type: 'thinking_start' },
      { type: 'thinking_delta', delta: 'considering' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'a.ts' } },
      { type: 'tool_result', toolUseId: 'tool-1', content: 'ok', isError: false },
      { type: 'usage', usage: { input_tokens: 1 }, costUsd: 0.01, durationMs: 42, stopReason: 'end_turn' },
      { type: 'error', message: 'failed', code: 'CLAUDE_CLI_FAILED' },
      { type: 'end' },
    ];

    events.forEach((event, index) => accumulator.consume(event, String(index + 1)));
    accumulator.forceFlush();

    expect(updateRunMessage).toHaveBeenCalledWith(db, {
      messageId: 'message-1',
      content: '',
      events,
      lastRunEventId: '8',
      now: runtime.clock.now(),
    });
    expect(accumulator.getUsage()).toEqual({
      usage: { input_tokens: 1 },
      costUsd: 0.01,
      durationMs: 42,
      stopReason: 'end_turn',
    });
  });

  it('does not persist stderr or raw events by default', () => {
    const { accumulator, db, runtime } = createAccumulator();

    accumulator.consume({ type: 'stderr', text: 'debug noise' }, '1');
    accumulator.consume({ type: 'raw', line: '{"debug":true}' }, '2');
    accumulator.consume({ type: 'status', label: 'still alive' }, '3');
    accumulator.forceFlush();

    expect(updateRunMessage).toHaveBeenCalledWith(db, {
      messageId: 'message-1',
      content: '',
      events: [{ type: 'status', label: 'still alive' }],
      lastRunEventId: '3',
      now: runtime.clock.now(),
    });
  });

  it('throttles DB writes to the run message flush policy', () => {
    const { accumulator, runtime } = createAccumulator();

    accumulator.consume({ type: 'text_delta', delta: 'a' }, '1');
    accumulator.consume({ type: 'text_delta', delta: 'b' }, '2');

    expect(updateRunMessage).not.toHaveBeenCalled();
    expect(runtime.pendingTimers()).toHaveLength(1);
    expect(runtime.pendingTimers()[0]?.delayMs).toBe(runMessageFlushPolicy.throttleMs);

    runtime.runNextTimer();

    expect(updateRunMessage).toHaveBeenCalledTimes(1);
  });

  it('forceFlush writes pending content and events immediately', () => {
    const { accumulator, runtime } = createAccumulator();

    accumulator.consume({ type: 'text_delta', delta: 'pending' }, '1');
    accumulator.forceFlush();

    expect(updateRunMessage).toHaveBeenCalledTimes(1);
    expect(runtime.pendingTimers()).toHaveLength(0);
  });

  it('terminal flush writes runStatus, endedAt, and lastRunEventId after pending updates', () => {
    const { accumulator, db, runtime } = createAccumulator({ messageId: 'assistant-1' });

    accumulator.consume({ type: 'text_delta', delta: 'done' }, '9');
    accumulator.flushTerminal({ runStatus: 'succeeded', endedAt: 2_000 });

    expect(updateRunMessage).toHaveBeenCalledWith(db, {
      messageId: 'assistant-1',
      content: 'done',
      events: [{ type: 'text_delta', delta: 'done' }],
      lastRunEventId: '9',
      now: runtime.clock.now(),
    });
    expect(updateAssistantMessageTerminal).toHaveBeenCalledWith(db, {
      messageId: 'assistant-1',
      runStatus: 'succeeded' satisfies RunStatus,
      lastRunEventId: '9',
      endedAt: 2_000,
      now: runtime.clock.now(),
    });
    expect(runtime.pendingTimers()).toHaveLength(0);
  });

  it('keeps content, events, timers, and message ids isolated between accumulator instances', () => {
    const first = createAccumulator({ messageId: 'assistant-1', startNow: 100 });
    const second = createAccumulator({ messageId: 'assistant-2', startNow: 200 });

    first.accumulator.consume({ type: 'text_delta', delta: 'first' }, '1');
    second.accumulator.consume({ type: 'status', label: 'second' }, '7');

    first.runtime.runNextTimer();

    expect(updateRunMessage).toHaveBeenCalledTimes(1);
    expect(updateRunMessage).toHaveBeenCalledWith(first.db, {
      messageId: 'assistant-1',
      content: 'first',
      events: [{ type: 'text_delta', delta: 'first' }],
      lastRunEventId: '1',
      now: first.runtime.clock.now(),
    });
    expect(second.runtime.pendingTimers()).toHaveLength(1);

    second.runtime.runNextTimer();

    expect(updateRunMessage).toHaveBeenCalledTimes(2);
    expect(updateRunMessage).toHaveBeenLastCalledWith(second.db, {
      messageId: 'assistant-2',
      content: '',
      events: [{ type: 'status', label: 'second' }],
      lastRunEventId: '7',
      now: second.runtime.clock.now(),
    });
  });
});

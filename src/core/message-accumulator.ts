import type { RunnerDatabase } from '../db/connection.js';
import {
  updateAssistantMessageStarted,
  updateAssistantMessageTerminal,
  updateRunMessage,
} from '../db/repositories.js';
import type { RunEvent } from './run-events.js';
import { runMessageFlushPolicy, type RunStatus } from './run-types.js';

export interface MessageAccumulatorClock {
  now(): number;
}

export interface MessageAccumulatorTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timerId: unknown): void;
}

export interface CreateMessageAccumulatorInput {
  db: RunnerDatabase;
  messageId: string;
  clock?: MessageAccumulatorClock;
  timer?: MessageAccumulatorTimer;
}

export interface StartRunInput {
  startedAt?: number;
}

export interface TerminalFlushInput {
  runStatus: RunStatus;
  endedAt?: number;
}

export interface UsageSnapshot {
  usage: unknown;
  costUsd: unknown;
  durationMs: unknown;
  stopReason: unknown;
}

const systemClock: MessageAccumulatorClock = {
  now: () => Date.now(),
};

const systemTimer: MessageAccumulatorTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timerId) => clearTimeout(timerId as ReturnType<typeof setTimeout>),
};

export function createMessageAccumulator(input: CreateMessageAccumulatorInput) {
  return new MessageAccumulator(input);
}

class MessageAccumulator {
  private readonly db: RunnerDatabase;
  private readonly messageId: string;
  private readonly clock: MessageAccumulatorClock;
  private readonly timer: MessageAccumulatorTimer;
  private content = '';
  private events: RunEvent[] = [];
  private lastRunEventId: string | null = null;
  private usage: UsageSnapshot | null = null;
  private flushTimer: unknown = null;
  private dirty = false;

  constructor(input: CreateMessageAccumulatorInput) {
    this.db = input.db;
    this.messageId = input.messageId;
    this.clock = input.clock ?? systemClock;
    this.timer = input.timer ?? systemTimer;
  }

  startRun(input: StartRunInput = {}): void {
    const now = this.clock.now();
    updateAssistantMessageStarted(this.db, {
      messageId: this.messageId,
      startedAt: input.startedAt ?? now,
      now,
    });
  }

  consume(event: RunEvent, eventId?: string): void {
    if (eventId !== undefined) {
      this.lastRunEventId = eventId;
    }

    if (event.type === 'text_delta') {
      this.content += event.delta;
      this.markDirty();
      return;
    }

    if (event.type === 'stderr' || event.type === 'raw') {
      return;
    }

    if (event.type === 'usage') {
      this.usage = {
        usage: event.usage,
        costUsd: event.costUsd,
        durationMs: event.durationMs,
        stopReason: event.stopReason,
      };
    }

    this.events.push(event);
    this.markDirty();
  }

  forceFlush(): void {
    if (this.flushTimer !== null) {
      this.timer.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushPending();
  }

  flushTerminal(input: TerminalFlushInput): void {
    this.forceFlush();

    const now = this.clock.now();
    updateAssistantMessageTerminal(this.db, {
      messageId: this.messageId,
      runStatus: input.runStatus,
      lastRunEventId: this.lastRunEventId,
      endedAt: input.endedAt ?? now,
      now,
    });
  }

  getUsage(): UsageSnapshot | null {
    return this.usage;
  }

  dispose(): void {
    if (this.flushTimer !== null) {
      this.timer.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer !== null) return;

    this.flushTimer = this.timer.setTimeout(() => {
      this.flushTimer = null;
      this.flushPending();
    }, runMessageFlushPolicy.throttleMs);
  }

  private flushPending(): void {
    if (!this.dirty) return;

    this.dirty = false;
    updateRunMessage(this.db, {
      messageId: this.messageId,
      content: this.content,
      events: [...this.events],
      lastRunEventId: this.lastRunEventId,
      now: this.clock.now(),
    });
  }
}

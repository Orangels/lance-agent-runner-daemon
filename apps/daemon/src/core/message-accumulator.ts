import type { RunnerDatabase } from '../db/connection.js';
import { createSqliteRunnerPersistence } from '../db/sqlite-persistence.js';
import type { RunnerPersistence } from '../db/types.js';
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
  persistence?: RunnerPersistence;
  db?: RunnerDatabase;
  messageId: string;
  workspaceId?: string;
  conversationId?: string;
  runId?: string;
  initialPosition?: number;
  nextMessageId?: () => string;
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
  private readonly persistence: RunnerPersistence;
  private messageId: string;
  private readonly workspaceId: string | null;
  private readonly conversationId: string | null;
  private readonly runId: string | null;
  private readonly nextMessageId: (() => string) | null;
  private readonly clock: MessageAccumulatorClock;
  private readonly timer: MessageAccumulatorTimer;
  private nextPosition: number;
  private sawAssistantMessageStart = false;
  private content = '';
  private thinkingContent = '';
  private events: RunEvent[] = [];
  private lastRunEventId: string | null = null;
  private usage: UsageSnapshot | null = null;
  private flushTimer: unknown = null;
  private dirty = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(input: CreateMessageAccumulatorInput) {
    const persistence =
      input.persistence ?? (input.db ? createSqliteRunnerPersistence(input.db) : null);
    if (!persistence) {
      throw new Error('MessageAccumulator requires persistence');
    }
    this.persistence = persistence;
    this.messageId = input.messageId;
    this.workspaceId = input.workspaceId ?? null;
    this.conversationId = input.conversationId ?? null;
    this.runId = input.runId ?? null;
    this.nextMessageId = input.nextMessageId ?? null;
    this.nextPosition = (input.initialPosition ?? 1) + 1;
    this.clock = input.clock ?? systemClock;
    this.timer = input.timer ?? systemTimer;
  }

  async startRun(input: StartRunInput = {}): Promise<void> {
    const now = this.clock.now();
    await this.persistence.updateAssistantMessageStarted({
      messageId: this.messageId,
      startedAt: input.startedAt ?? now,
      now,
    });
  }

  consume(event: RunEvent, eventId?: string): void {
    if (event.type === 'assistant_message_start') {
      this.startAssistantMessageSegment();
      return;
    }

    if (eventId !== undefined) {
      this.lastRunEventId = eventId;
    }

    if (event.type === 'text_delta') {
      this.content += event.delta;
      this.events.push(event);
      this.markDirty();
      return;
    }

    if (event.type === 'thinking_delta') {
      this.thinkingContent += event.delta;
      this.events.push(event);
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

  async forceFlush(): Promise<void> {
    if (this.flushTimer !== null) {
      this.timer.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushPending();
    await this.writeQueue;
  }

  async flushTerminal(input: TerminalFlushInput): Promise<void> {
    await this.forceFlush();

    const now = this.clock.now();
    if (this.runId) {
      await this.persistence.updateAssistantMessagesTerminalForRun({
        runId: this.runId,
        runStatus: input.runStatus,
        endedAt: input.endedAt ?? now,
        now,
      });
    }
    await this.persistence.updateAssistantMessageTerminal({
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
      void this.flushPending();
    }, runMessageFlushPolicy.throttleMs);
  }

  private startAssistantMessageSegment(): void {
    if (!this.sawAssistantMessageStart) {
      this.sawAssistantMessageStart = true;
      return;
    }

    if (!this.canInsertAdditionalAssistantMessages()) {
      return;
    }

    void this.forceFlush();
    const now = this.clock.now();
    const messageId = this.nextMessageId!();
    const workspaceId = this.workspaceId!;
    const conversationId = this.conversationId!;
    const runId = this.runId!;
    const position = this.nextPosition;
    this.enqueueWrite(() => this.persistence.insertAssistantRunMessage({
      id: messageId,
      workspaceId,
      conversationId,
      runId,
      position,
      runStatus: 'running',
      startedAt: now,
      now,
    }).then(() => undefined));

    this.messageId = messageId;
    this.nextPosition += 1;
    this.content = '';
    this.thinkingContent = '';
    this.events = [];
    this.lastRunEventId = null;
  }

  private canInsertAdditionalAssistantMessages(): boolean {
    return Boolean(this.workspaceId && this.conversationId && this.runId && this.nextMessageId);
  }

  private async flushPending(): Promise<void> {
    if (!this.dirty) return;

    this.dirty = false;
    const messageId = this.messageId;
    const content = this.content;
    const thinkingContent = this.thinkingContent;
    const events = [...this.events];
    const lastRunEventId = this.lastRunEventId;
    const now = this.clock.now();
    await this.enqueueWrite(() =>
      this.persistence.updateRunMessage({
        messageId,
        content,
        thinkingContent,
        events,
        lastRunEventId,
        now,
      }).then(() => undefined),
    );
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

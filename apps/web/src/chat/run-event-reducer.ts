import type { RunDetailResponse, RunStatus } from '../api/types.js';
import type { StreamedRunEvent } from '../api/sse-stream.js';
import type { DemoArtifact, DemoChatMessage, DemoRunEvent, WorkflowMode } from './chat-types.js';

const runStatuses = new Set<RunStatus>([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
]);

interface CreateAssistantMessageInput {
  id: string;
  runId?: string;
  runMode?: WorkflowMode;
}

export function createAssistantMessage(input: CreateAssistantMessageInput): DemoChatMessage {
  return {
    id: input.id,
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    runId: input.runId,
    runMode: input.runMode,
    runStatus: input.runId ? 'queued' : undefined,
    events: [],
    artifacts: [],
  };
}

export function applyRunEventToMessage(message: DemoChatMessage, record: StreamedRunEvent): DemoChatMessage {
  const event = toDemoRunEvent(record);
  const next: DemoChatMessage = {
    ...message,
    events: [...(message.events ?? []), event],
    lastRunEventId: record.id ?? message.lastRunEventId,
  };

  if (event.type === 'text_delta' && typeof event.delta === 'string') {
    return { ...next, content: `${next.content}${event.delta}` };
  }

  if (event.type === 'status' && typeof event.label === 'string' && isRunStatus(event.label)) {
    return { ...next, runStatus: event.label };
  }

  if (event.type === 'artifact_finalized') {
    const artifact = toDemoArtifact(event.artifact);
    return artifact ? { ...next, artifacts: [...(next.artifacts ?? []), artifact] } : next;
  }

  if (event.type === 'error') {
    return {
      ...next,
      error: {
        code: typeof event.code === 'string' ? event.code : undefined,
        message: typeof event.message === 'string' ? event.message : 'Run failed',
      },
    };
  }

  if (event.type === 'end') {
    return {
      ...next,
      endedAt: Date.now(),
      runStatus: isRunStatus(event.status) ? event.status : next.runStatus,
    };
  }

  return next;
}

export function reconcileMessagesWithRunDetail(
  messages: DemoChatMessage[],
  detail: RunDetailResponse,
): DemoChatMessage[] {
  const durableAssistant = detail.messages
    .filter((message) => message.role === 'assistant')
    .sort((left, right) => right.position - left.position)[0];

  if (!durableAssistant) {
    return messages;
  }

  return messages.map((message) => {
    if (message.role !== 'assistant' || message.runId !== detail.run.id) {
      return message;
    }

    const error = detail.run.errorCode || detail.run.errorMessage
      ? {
          code: detail.run.errorCode ?? undefined,
          message: detail.run.errorMessage ?? 'Run failed',
        }
      : message.error;

    return {
      ...message,
      content: durableAssistant.content,
      events: normalizeDurableEvents(durableAssistant.events),
      runStatus: durableAssistant.runStatus ?? detail.run.status,
      lastRunEventId: durableAssistant.lastRunEventId ?? detail.run.lastRunEventId ?? message.lastRunEventId,
      endedAt: durableAssistant.endedAt ?? message.endedAt,
      error,
    };
  });
}

function toDemoRunEvent(record: StreamedRunEvent): DemoRunEvent {
  return {
    ...record.event,
    id: record.id,
  };
}

function toDemoArtifact(value: unknown): DemoArtifact | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as DemoArtifact;
}

function normalizeDurableEvents(events: unknown[] | null): DemoRunEvent[] {
  return Array.isArray(events) ? (events as DemoRunEvent[]) : [];
}

function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && runStatuses.has(value as RunStatus);
}

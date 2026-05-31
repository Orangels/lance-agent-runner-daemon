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

  // Daemon status labels are free-form. Treat labels that happen to match a
  // public RunStatus as a best-effort UI hint, and leave all other labels as
  // event-only display data.
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

export function applyRunEventToMessages(
  messages: DemoChatMessage[],
  runId: string,
  record: StreamedRunEvent,
  nextAssistantId: () => string,
): DemoChatMessage[] {
  if (record.event.type === 'assistant_message_start') {
    return applyAssistantMessageStart(messages, runId, record, nextAssistantId);
  }

  const targetIndex = findLastAssistantIndexForRun(messages, runId);
  if (targetIndex === -1) {
    return messages;
  }

  return messages.map((message, index) =>
    index === targetIndex ? applyRunEventToMessage(message, record) : message,
  );
}

export function reconcileMessagesWithRunDetail(
  messages: DemoChatMessage[],
  detail: RunDetailResponse,
): DemoChatMessage[] {
  const durableAssistants = detail.messages
    .filter((message) => message.role === 'assistant')
    .sort((left, right) => left.position - right.position);

  if (durableAssistants.length === 0) {
    return messages;
  }

  const firstAssistantIndex = messages.findIndex(
    (message) => message.role === 'assistant' && message.runId === detail.run.id,
  );
  const insertIndex = firstAssistantIndex === -1 ? messages.length : firstAssistantIndex;
  const localAssistants = messages.filter(
    (message) => message.role === 'assistant' && message.runId === detail.run.id,
  );
  const template = localAssistants[0];
  const artifactSource = [...localAssistants].reverse().find((message) => (message.artifacts ?? []).length > 0);
  const durableChatMessages = durableAssistants.map((message, index) =>
    toDemoAssistantMessageFromDetail(detail, message, {
      template: index === 0 ? template : undefined,
      artifacts: index === durableAssistants.length - 1 ? (artifactSource?.artifacts ?? []) : [],
      includeRunError: index === durableAssistants.length - 1,
    }),
  );

  const withoutLocalAssistants = messages.filter(
    (message) => !(message.role === 'assistant' && message.runId === detail.run.id),
  );

  // Current-run assistant messages are removed before slicing. Because
  // insertIndex points at the first one, the filtered prefix length is stable.
  return [
    ...withoutLocalAssistants.slice(0, insertIndex),
    ...durableChatMessages,
    ...withoutLocalAssistants.slice(insertIndex),
  ];
}

export function attachArtifactsToLastAssistantMessage(
  messages: DemoChatMessage[],
  runId: string,
  artifacts: DemoArtifact[],
): DemoChatMessage[] {
  const targetIndex = findLastAssistantIndexForRun(messages, runId);
  if (targetIndex === -1) {
    return messages;
  }

  return messages.map((message, index) =>
    message.role === 'assistant' && message.runId === runId
      ? { ...message, artifacts: index === targetIndex ? artifacts : [] }
      : message,
  );
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

function applyAssistantMessageStart(
  messages: DemoChatMessage[],
  runId: string,
  record: StreamedRunEvent,
  nextAssistantId: () => string,
): DemoChatMessage[] {
  const targetIndex = findLastAssistantIndexForRun(messages, runId);
  if (targetIndex === -1) {
    return messages;
  }

  const target = messages[targetIndex]!;
  if (isEmptyAssistantPlaceholder(target)) {
    return messages.map((message, index) =>
      index === targetIndex ? applyRunEventToMessage(message, record) : message,
    );
  }

  const nextMessage = applyRunEventToMessage(
    {
      ...createAssistantMessage({
        id: nextAssistantId(),
        runId,
        runMode: target.runMode,
      }),
      runStatus: target.runStatus,
    },
    record,
  );

  return [
    ...messages.slice(0, targetIndex + 1),
    nextMessage,
    ...messages.slice(targetIndex + 1),
  ];
}

function findLastAssistantIndexForRun(messages: DemoChatMessage[], runId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.runId === runId) {
      return index;
    }
  }
  return -1;
}

function isEmptyAssistantPlaceholder(message: DemoChatMessage): boolean {
  return (
    message.content.length === 0 &&
    (message.events ?? []).every((event) => event.type === 'status' || event.type === 'assistant_message_start')
  );
}

function toDemoAssistantMessageFromDetail(
  detail: RunDetailResponse,
  message: RunDetailResponse['messages'][number],
  input: {
    template?: DemoChatMessage;
    artifacts: DemoArtifact[];
    includeRunError: boolean;
  },
): DemoChatMessage {
  const error = input.includeRunError && (detail.run.errorCode || detail.run.errorMessage)
    ? {
        code: detail.run.errorCode ?? undefined,
        message: detail.run.errorMessage ?? 'Run failed',
      }
    : input.template?.error;

  return {
    id: input.template?.id ?? message.id,
    role: 'assistant',
    content: message.content,
    createdAt: message.createdAt,
    runId: detail.run.id,
    runMode: input.template?.runMode,
    runStatus: message.runStatus ?? detail.run.status,
    events: normalizeDurableEvents(message.events),
    artifacts: input.artifacts,
    lastRunEventId: message.lastRunEventId ?? detail.run.lastRunEventId ?? input.template?.lastRunEventId,
    endedAt: message.endedAt ?? input.template?.endedAt,
    error,
  };
}

function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && runStatuses.has(value as RunStatus);
}

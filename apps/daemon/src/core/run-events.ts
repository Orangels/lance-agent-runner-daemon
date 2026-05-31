import type { RunStatus } from './run-types.js';
import type { PublicArtifact } from './run-types.js';

export const rawEventLineMaxLength = 2_000;

export type RunEvent =
  | {
      type: 'status';
      label: string;
      model?: unknown;
      sessionId?: unknown;
      ttftMs?: number;
    }
  | {
      type: 'assistant_message_start';
      messageId: string | null;
    }
  | {
      type: 'text_delta';
      delta: string;
    }
  | {
      type: 'thinking_start';
    }
  | {
      type: 'thinking_delta';
      delta: string;
    }
  | {
      type: 'tool_use';
      id: unknown;
      name: unknown;
      input: unknown;
    }
  | {
      type: 'tool_result';
      toolUseId: unknown;
      content: string;
      isError: boolean;
    }
  | {
      type: 'usage';
      usage: unknown;
      costUsd: unknown;
      durationMs: unknown;
      stopReason: unknown;
    }
  | {
      type: 'error';
      message: string;
      code?: string;
      details?: unknown;
    }
  | {
      type: 'artifact_finalized';
      artifact: Omit<PublicArtifact, 'workspaceId'>;
    }
  | {
      type: 'stderr';
      text: string;
    }
  | {
      type: 'raw';
      line: string;
    }
  | {
      type: 'end';
      status?: RunStatus;
    };

export type RunEventSink = (event: RunEvent) => void;

export function capRawEventLine(line: string): string {
  return line.slice(0, rawEventLineMaxLength);
}

export function parseRunEventId(id: string | null | undefined): number | null {
  if (id === null || id === undefined) return null;

  const trimmed = id.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return null;

  return parsed;
}

export function formatRunEventId(id: number): string {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error(`Invalid run event id: ${id}`);
  }

  return String(id);
}

export function compareRunEventIds(left: string, right: string): number {
  const parsedLeft = parseRunEventId(left);
  const parsedRight = parseRunEventId(right);

  if (parsedLeft === null || parsedRight === null) {
    throw new Error('Run event ids must be non-negative safe integers');
  }

  return parsedLeft - parsedRight;
}

export function shouldReplayEventAfter(eventId: string, afterId: string | null | undefined): boolean {
  const parsedEventId = parseRunEventId(eventId);
  if (parsedEventId === null) return false;

  const parsedAfterId = parseRunEventId(afterId);
  if (parsedAfterId === null) return true;

  return parsedEventId > parsedAfterId;
}

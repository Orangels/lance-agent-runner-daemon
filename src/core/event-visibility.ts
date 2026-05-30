import { capRawEventLine, type RunEvent } from './run-events.js';
import type { EventVisibility } from './run-types.js';

interface VisibilityClient {
  canReadDebugEvents: boolean;
}

interface VisibilityProfile {
  eventVisibility: EventVisibility;
}

interface VisibilityRequest {
  eventVisibility?: EventVisibility;
}

export interface ResolveEventVisibilityInput {
  client: VisibilityClient;
  profile: VisibilityProfile;
  request?: VisibilityRequest;
}

const visibilityRank: Record<EventVisibility, number> = {
  quiet: 0,
  normal: 1,
  debug: 2,
};

const rankedVisibilities: EventVisibility[] = ['quiet', 'normal', 'debug'];

const eventVisibilityByType: Record<RunEvent['type'], EventVisibility> = {
  status: 'quiet',
  text_delta: 'quiet',
  usage: 'quiet',
  error: 'quiet',
  end: 'quiet',
  thinking_start: 'normal',
  thinking_delta: 'normal',
  tool_use: 'normal',
  tool_result: 'normal',
  stderr: 'debug',
  raw: 'debug',
};

export function resolveEventVisibility(input: ResolveEventVisibilityInput): EventVisibility {
  const requestVisibility = input.request?.eventVisibility ?? input.profile.eventVisibility;
  const profileCeiling = minVisibility(input.profile.eventVisibility, requestVisibility);

  if (profileCeiling === 'debug' && !input.client.canReadDebugEvents) {
    return 'normal';
  }

  return profileCeiling;
}

export function filterRunEvents(
  events: readonly RunEvent[],
  visibility: EventVisibility,
): RunEvent[] {
  return events.flatMap((event) => {
    const filtered = filterRunEvent(event, visibility);
    return filtered ? [filtered] : [];
  });
}

export function filterRunEvent(event: RunEvent, visibility: EventVisibility): RunEvent | null {
  if (visibilityRank[eventVisibilityByType[event.type]] > visibilityRank[visibility]) {
    return null;
  }

  if (event.type === 'stderr') {
    return { ...event, text: sanitizeString(capRawEventLine(event.text)) };
  }

  if (event.type === 'raw') {
    return { ...event, line: sanitizeString(capRawEventLine(event.line)) };
  }

  return sanitizeValue(event) as RunEvent;
}

function minVisibility(left: EventVisibility, right: EventVisibility): EventVisibility {
  return rankedVisibilities[Math.min(visibilityRank[left], visibilityRank[right])]!;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, sanitizeValue(nestedValue)]),
    );
  }

  return value;
}

function sanitizeString(value: string): string {
  return value.replace(/(?:^|[\s"'([{:=])\/[^\s"'()[\]{}<>]+/g, (match) => {
    const prefix = match.startsWith('/') ? '' : match[0]!;
    return `${prefix}[redacted-path]`;
  });
}

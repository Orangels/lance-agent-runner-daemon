import { authHeaders, normalizeBaseUrl } from './daemon-client.js';

type FetchLike = typeof fetch;

export interface StreamedDaemonEvent {
  type: string;
  [key: string]: unknown;
}

export interface StreamedRunEvent {
  id?: string;
  event: StreamedDaemonEvent;
}

export interface StreamRunEventsInput {
  baseUrl: string;
  apiKey: string;
  runId: string;
  after?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  onEvent: (event: StreamedRunEvent) => void;
}

export type StreamRunEventsResult =
  | {
      ok: true;
      terminal: boolean;
    }
  | {
      ok: false;
      reason: 'http';
      status: number;
    }
  | {
      ok: false;
      reason: 'parse';
      message: string;
    }
  | {
      ok: false;
      reason: 'network';
      error: unknown;
    }
  | {
      ok: false;
      reason: 'aborted';
    };

interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

export async function streamRunEvents(input: StreamRunEventsInput): Promise<StreamRunEventsResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = buildEventsUrl(input);

  try {
    const response = await fetchImpl(url, {
      headers: authHeaders(input.apiKey),
      method: 'GET',
      signal: input.signal,
    });

    if (!response.ok) {
      return { ok: false, reason: 'http', status: response.status };
    }

    if (!response.body) {
      return { ok: false, reason: 'network', error: new Error('SSE response has no body') };
    }

    return await readSseBody(response.body, input.onEvent);
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, reason: 'aborted' };
    }
    return { ok: false, reason: 'network', error };
  }
}

function buildEventsUrl(input: StreamRunEventsInput): string {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const path = `${baseUrl}/api/runs/${encodeURIComponent(input.runId)}/events`;
  if (!input.after) {
    return path;
  }
  const params = new URLSearchParams({ after: input.after });
  return `${path}?${params.toString()}`;
}

async function readSseBody(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StreamedRunEvent) => void,
): Promise<StreamRunEventsResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        const result = drainFrames(buffer, onEvent);
        buffer = result.remainder;
        terminal = terminal || result.terminal;
        if (result.error) {
          return result.error;
        }
      }

      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          const result = handleFrame(buffer, onEvent);
          terminal = terminal || result.terminal;
          if (result.error) {
            return result.error;
          }
        }
        return { ok: true, terminal };
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, reason: 'aborted' };
    }
    return { ok: false, reason: 'network', error };
  } finally {
    reader.releaseLock();
  }
}

function drainFrames(
  buffer: string,
  onEvent: (event: StreamedRunEvent) => void,
): { remainder: string; terminal: boolean; error?: Extract<StreamRunEventsResult, { ok: false }> } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const chunks = normalized.split('\n\n');
  const remainder = chunks.pop() ?? '';
  let terminal = false;

  for (const chunk of chunks) {
    const result = handleFrame(chunk, onEvent);
    terminal = terminal || result.terminal;
    if (result.error) {
      return { remainder, terminal, error: result.error };
    }
  }

  return { remainder, terminal };
}

function handleFrame(
  chunk: string,
  onEvent: (event: StreamedRunEvent) => void,
): { terminal: boolean; error?: Extract<StreamRunEventsResult, { ok: false }> } {
  const frame = parseFrame(chunk);
  if (!frame || frame.event !== 'agent' || frame.data.length === 0) {
    return { terminal: false };
  }

  let event: StreamedDaemonEvent;
  try {
    event = JSON.parse(frame.data) as StreamedDaemonEvent;
  } catch (error) {
    return { terminal: false, error: { ok: false, reason: 'parse', message: String(error) } };
  }

  onEvent({ event, id: frame.id });
  return { terminal: event.type === 'end' };
}

function parseFrame(chunk: string): SseFrame | null {
  const frame: SseFrame = { data: '' };
  const dataLines: string[] = [];

  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'id') {
      frame.id = value;
    } else if (field === 'event') {
      frame.event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (!frame.id && !frame.event && dataLines.length === 0) {
    return null;
  }

  frame.data = dataLines.join('\n');
  return frame;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

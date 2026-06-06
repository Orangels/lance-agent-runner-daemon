import { describe, expect, it, vi } from 'vitest';
import { streamRunEvents } from '../../src/api/sse-stream.js';

function streamResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, { status: 200, ...init });
}

describe('streamRunEvents', () => {
  it('opens an authenticated fetch SSE stream without query-string secrets', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse(['event: agent\ndata: {"type":"end","status":"succeeded"}\n\n']));
    const onEvent = vi.fn();

    const result = await streamRunEvents({
      after: '7',
      apiKey: 'secret',
      baseUrl: 'http://daemon.test/',
      fetchImpl,
      onEvent,
      runId: 'run_1',
    });

    expect(result).toEqual({ ok: true, terminal: true });
    expect(fetchImpl).toHaveBeenCalledWith('http://daemon.test/api/runs/run_1/events?after=7', {
      headers: { Authorization: 'Bearer secret' },
      method: 'GET',
      signal: undefined,
    });
    expect(onEvent).toHaveBeenCalledWith({ event: { type: 'end', status: 'succeeded' }, id: undefined });
  });

  it('parses split chunks, multiple frames, keepalive comments, and event ids', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamResponse([
        ': keepalive\n\nid: 8\nevent: agent\ndata: {"type":"text_delta","delta":"Hel',
        'lo"}\n\nid: 9\nevent: ignored\ndata: {"type":"text_delta","delta":"no"}\n\n',
        'id: 10\nevent: agent\ndata: {"type":"end","status":"succeeded"}\n\n',
      ]),
    );
    const onEvent = vi.fn();

    const result = await streamRunEvents({
      apiKey: 'secret',
      baseUrl: 'http://daemon.test',
      fetchImpl,
      onEvent,
      runId: 'run_1',
    });

    expect(result).toEqual({ ok: true, terminal: true });
    expect(onEvent).toHaveBeenNthCalledWith(1, {
      event: { type: 'text_delta', delta: 'Hello' },
      id: '8',
    });
    expect(onEvent).toHaveBeenNthCalledWith(2, {
      event: { type: 'end', status: 'succeeded' },
      id: '10',
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('returns a structured http result for 404 so callers can fall back to run detail', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No buffer' } }), { status: 404 }));

    await expect(
      streamRunEvents({
        apiKey: 'secret',
        baseUrl: 'http://daemon.test',
        fetchImpl,
        onEvent: vi.fn(),
        runId: 'run_1',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'http', status: 404 });
  });

  it('returns a parse result for malformed event JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse(['event: agent\ndata: {nope}\n\n']));

    await expect(
      streamRunEvents({
        apiKey: 'secret',
        baseUrl: 'http://daemon.test',
        fetchImpl,
        onEvent: vi.fn(),
        runId: 'run_1',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'parse' });
  });

  it('returns an aborted result when the request is aborted', async () => {
    const error = new DOMException('Aborted', 'AbortError');
    const fetchImpl = vi.fn().mockRejectedValue(error);

    await expect(
      streamRunEvents({
        apiKey: 'secret',
        baseUrl: 'http://daemon.test',
        fetchImpl,
        onEvent: vi.fn(),
        runId: 'run_1',
      }),
    ).resolves.toEqual({ ok: false, reason: 'aborted' });
  });
});

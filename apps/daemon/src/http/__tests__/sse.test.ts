import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSseResponse } from '../sse.js';

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headers = new Map<string, string>();
  writes: string[] = [];
  setHeader = vi.fn((name: string, value: string) => {
    this.headers.set(name, value);
    return this;
  });
  flushHeaders = vi.fn();
  write = vi.fn((chunk: string) => {
    this.writes.push(chunk);
    return true;
  });
  end = vi.fn(() => {
    this.writableEnded = true;
    this.emit('finish');
    return this;
  });

  asExpressResponse(): Response {
    return this as unknown as Response;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createSseResponse', () => {
  it('sets SSE headers and flushes them when supported', () => {
    const response = new FakeResponse();

    createSseResponse(response.asExpressResponse(), { keepAliveIntervalMs: 0 });

    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform');
    expect(response.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(response.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(response.flushHeaders).toHaveBeenCalledOnce();
  });

  it('writes one complete SSE frame with id, event, and data', () => {
    const response = new FakeResponse();
    const sse = createSseResponse(response.asExpressResponse(), { keepAliveIntervalMs: 0 });

    const sent = sse.send('agent', { type: 'text_delta' }, '3');

    expect(sent).toBe(true);
    expect(response.write).toHaveBeenCalledTimes(1);
    expect(response.writes[0]).toBe('id: 3\nevent: agent\ndata: {"type":"text_delta"}\n\n');
  });

  it('serializes multiline JSON data as one data line', () => {
    const response = new FakeResponse();
    const sse = createSseResponse(response.asExpressResponse(), { keepAliveIntervalMs: 0 });

    sse.send('agent', { text: 'first\nsecond' }, '4');

    expect(response.writes[0]).toBe('id: 4\nevent: agent\ndata: {"text":"first\\nsecond"}\n\n');
  });

  it('writes keepalive comments and clears the heartbeat on response close', () => {
    vi.useFakeTimers();
    const response = new FakeResponse();
    createSseResponse(response.asExpressResponse(), { keepAliveIntervalMs: 1000 });

    vi.advanceTimersByTime(1000);

    expect(response.writes).toEqual([': keepalive\n\n']);

    response.emit('close');
    vi.advanceTimersByTime(3000);

    expect(response.writes).toEqual([': keepalive\n\n']);
  });

  it('returns false after the response is destroyed or ended', () => {
    const destroyedResponse = new FakeResponse();
    destroyedResponse.destroyed = true;
    const destroyedSse = createSseResponse(destroyedResponse.asExpressResponse(), {
      keepAliveIntervalMs: 0,
    });

    expect(destroyedSse.send('agent', { type: 'text_delta' })).toBe(false);
    expect(destroyedResponse.write).not.toHaveBeenCalled();

    const endedResponse = new FakeResponse();
    endedResponse.writableEnded = true;
    const endedSse = createSseResponse(endedResponse.asExpressResponse(), {
      keepAliveIntervalMs: 0,
    });

    expect(endedSse.send('agent', { type: 'text_delta' })).toBe(false);
    expect(endedResponse.write).not.toHaveBeenCalled();
  });
});

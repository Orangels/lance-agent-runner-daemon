import type { Response } from 'express';

export const DEFAULT_SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export interface SseResponseOptions {
  keepAliveIntervalMs?: number;
}

export interface SseResponse {
  send(event: string, data: unknown, id?: string | number | null): boolean;
  end(): void;
  cleanup(): void;
}

type KeepAliveTimer = ReturnType<typeof setInterval>;

export function createSseResponse(
  res: Response,
  { keepAliveIntervalMs = DEFAULT_SSE_KEEPALIVE_INTERVAL_MS }: SseResponseOptions = {},
): SseResponse {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const canWrite = () => !res.destroyed && !res.writableEnded;
  const writeKeepAlive = () => {
    if (canWrite()) {
      res.write(': keepalive\n\n');
    }
  };

  let heartbeat: KeepAliveTimer | null = null;
  if (keepAliveIntervalMs > 0) {
    heartbeat = setInterval(writeKeepAlive, keepAliveIntervalMs);
    heartbeat.unref?.();
  }

  const cleanup = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);

  return {
    send(event, data, id = null) {
      if (!canWrite()) {
        return false;
      }

      const idLine = id !== null && id !== undefined ? `id: ${id}\n` : '';
      res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    },

    end() {
      cleanup();
      if (canWrite()) {
        res.end();
      }
    },

    cleanup,
  };
}

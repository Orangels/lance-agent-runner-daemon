import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { WebhookConfig } from '../config/profiles.js';
import {
  webhookDeliveryNotifyChannel,
} from '../db/postgres/repositories.js';
import type {
  RunnerPersistence,
  WebhookDeliveryJobRecord,
} from '../db/types.js';
import type { DaemonLogger } from './daemon-logger.js';
import { noopDaemonLogger } from './daemon-logger.js';
import { signWebhookPayload } from './webhook-signing.js';
import { assertWebhookUrlAllowed, type WebhookDnsLookup } from './webhook-url-policy.js';

type FetchLike = typeof fetch;
type ResponseBodyChunk = Uint8Array<ArrayBufferLike>;
type ResponseBodyReader = ReadableStreamDefaultReader<ResponseBodyChunk>;
type ResponseBodyReadResult = Awaited<ReturnType<ResponseBodyReader['read']>>;

interface ListenerNotification {
  channel: string;
  payload?: string;
}

interface ListenerClient {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<unknown>;
  on(event: 'notification', listener: (message: ListenerNotification) => void): this;
  on(event: 'error' | 'end', listener: (error?: unknown) => void): this;
}

export interface WebhookDeliveryService {
  start(): void;
  stop(): Promise<void>;
  drainDue(): Promise<number>;
  recoverDueAndScheduleNext(): Promise<void>;
}

export interface CreateWebhookDeliveryServiceInput {
  config: WebhookConfig;
  persistence: RunnerPersistence;
  databaseUrl?: string;
  createListenerClient?: () => ListenerClient;
  fetchImpl?: FetchLike;
  lookup?: WebhookDnsLookup;
  daemonLogger?: DaemonLogger;
  clock?: () => number;
  timer?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(timerId: unknown): void;
  };
  workerId?: string;
}

const minRecheckDelayMs = 250;

const defaultTimer = {
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (timerId: unknown) => clearTimeout(timerId as ReturnType<typeof setTimeout>),
};

export function createWebhookDeliveryService(input: CreateWebhookDeliveryServiceInput): WebhookDeliveryService {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = input.clock ?? Date.now;
  const timer = input.timer ?? defaultTimer;
  const daemonLogger = input.daemonLogger ?? noopDaemonLogger;
  const workerId = input.workerId ?? `webhook-worker-${process.pid}`;
  const createListenerClient = input.createListenerClient ?? (() => {
    if (!input.databaseUrl) {
      throw new Error('databaseUrl is required for webhook LISTEN client');
    }
    return new pg.Client({ connectionString: input.databaseUrl });
  });

  const inFlight = new Set<Promise<void>>();
  const inFlightControllers = new Set<AbortController>();
  let stopped = false;
  let started = false;
  let listener: ListenerClient | null = null;
  let reconnectTimerId: unknown = null;
  let keepaliveTimerId: unknown = null;
  let nextDueTimerId: unknown = null;
  let nextDueTimerAt: number | null = null;
  let draining = false;
  let drainAgain = false;
  let reconnecting = false;

  function start(): void {
    if (started || stopped || !input.config.enabled) return;
    started = true;
    void connectListenRecover();
  }

  async function stop(): Promise<void> {
    stopped = true;
    clearTimer('reconnect');
    clearTimer('keepalive');
    clearTimer('nextDue');
    const activeListener = listener;
    listener = null;
    if (activeListener) {
      await activeListener.end().catch((error) => {
        daemonLogger.warn('webhook_listener_close_failed', { error });
      });
    }

    const grace = wait(input.config.stopGraceMs);
    await Promise.race([Promise.allSettled(Array.from(inFlight)), grace]);
    for (const controller of inFlightControllers) {
      controller.abort();
    }
    await Promise.allSettled(Array.from(inFlight));
  }

  async function connectListenRecover(): Promise<void> {
    if (stopped || reconnecting || !input.config.enabled) return;
    reconnecting = true;
    try {
      const client = createListenerClient();
      await client.connect();
      if (stopped) {
        await client.end().catch(() => {});
        return;
      }
      client.on('notification', handleNotification);
      client.on('error', (error) => {
        daemonLogger.warn('webhook_listener_error', { error });
        scheduleReconnect();
      });
      client.on('end', () => {
        if (!stopped) scheduleReconnect();
      });
      await client.query(`LISTEN ${webhookDeliveryNotifyChannel}`);
      listener = client;
      scheduleKeepalive();
      await recoverDueAndScheduleNext();
    } catch (error) {
      daemonLogger.warn('webhook_listener_connect_failed', { error });
      scheduleReconnect();
    } finally {
      reconnecting = false;
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    clearTimer('keepalive');
    clearTimer('nextDue');
    const current = listener;
    listener = null;
    if (current) {
      void current.end().catch(() => {});
    }
    if (reconnectTimerId !== null) return;
    reconnectTimerId = timer.setTimeout(() => {
      reconnectTimerId = null;
      void connectListenRecover();
    }, input.config.listenReconnectBackoffMs);
  }

  function scheduleKeepalive(): void {
    clearTimer('keepalive');
    if (stopped || !listener) return;
    keepaliveTimerId = timer.setTimeout(() => {
      keepaliveTimerId = null;
      void runKeepalive();
    }, input.config.listenKeepaliveMs);
  }

  async function runKeepalive(): Promise<void> {
    const client = listener;
    if (stopped || !client) return;
    try {
      await withTimeout(client.query('SELECT 1'), input.config.listenKeepaliveTimeoutMs);
      scheduleKeepalive();
    } catch (error) {
      daemonLogger.warn('webhook_listener_keepalive_failed', { error });
      scheduleReconnect();
    }
  }

  function handleNotification(message: ListenerNotification): void {
    if (message.channel !== webhookDeliveryNotifyChannel) return;
    try {
      const parsed = parseNotificationPayload(message.payload);
      if (parsed.nextAttemptAt <= now()) {
        void drainDue();
      } else {
        scheduleNextDue(parsed.nextAttemptAt);
      }
    } catch (error) {
      daemonLogger.warn('webhook_notification_malformed', { error });
      void recoverDueAndScheduleNext();
    }
  }

  async function recoverDueAndScheduleNext(): Promise<void> {
    if (stopped || !input.config.enabled) return;
    const claimed = await drainDue();
    if (stopped) return;
    if (claimed === 0) {
      await scheduleFromPersistence();
    }
  }

  async function drainDue(): Promise<number> {
    if (stopped || !input.config.enabled) return 0;
    if (draining) {
      drainAgain = true;
      return 0;
    }
    draining = true;
    let totalClaimed = 0;
    try {
      do {
        drainAgain = false;
        if (stopped) break;
        const claimed = await drainOnce();
        totalClaimed += claimed;
        if (stopped) break;
        if (claimed === input.config.claimLimit) {
          drainAgain = true;
        }
      } while (drainAgain && !stopped);
    } finally {
      draining = false;
    }
    if (!stopped) {
      await scheduleFromPersistence();
    }
    return totalClaimed;
  }

  async function drainOnce(): Promise<number> {
    const capturedNow = now();
    const result = await input.persistence.claimDueWebhookDeliveries({
      now: capturedNow,
      staleDeliveringBefore: capturedNow - input.config.lockTimeoutMs,
      lockedBy: workerId,
      limit: input.config.claimLimit,
      maxAttempts: input.config.maxAttempts,
    });
    for (const abandonedId of result.abandonedIds) {
      daemonLogger.warn('webhook_delivery_abandoned_by_claim', { deliveryId: abandonedId });
    }
    if (result.claimed.length === 0) {
      return 0;
    }
    await deliverClaimed(result.claimed);
    return result.claimed.length;
  }

  async function deliverClaimed(deliveries: WebhookDeliveryJobRecord[]): Promise<void> {
    let index = 0;
    const workers = Array.from(
      { length: Math.min(input.config.maxConcurrentDeliveries, deliveries.length) },
      async () => {
        while (!stopped && index < deliveries.length) {
          const delivery = deliveries[index++]!;
          const promise = deliverOne(delivery).finally(() => {
            inFlight.delete(promise);
          });
          inFlight.add(promise);
          await promise;
        }
      },
    );
    await Promise.allSettled(workers);
  }

  async function deliverOne(delivery: WebhookDeliveryJobRecord): Promise<void> {
    const startedAt = now();
    let responseStatus: number | null = null;
    let responseBodyPreview: string | null = null;
    let errorMessage: string | null = null;
    let success = false;
    let retryable = false;

    try {
      const targetUrl = await assertWebhookUrlAllowed({
        url: delivery.webhookUrl,
        config: input.config,
        lookup: input.lookup,
      });
      const rawBody = JSON.stringify(injectDeliveryAttempt(delivery.payload, delivery.attemptCount));
      const timestamp = now();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Daemon-Webhook-Id': delivery.id,
        'X-Daemon-Webhook-Timestamp': String(timestamp),
      };
      if (delivery.webhookSecret) {
        headers['X-Daemon-Webhook-Signature'] = signWebhookPayload({
          secret: delivery.webhookSecret,
          timestamp,
          rawBody,
        });
      }
      const controller = new AbortController();
      inFlightControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), input.config.requestTimeoutMs);
      try {
        const response = await fetchImpl(targetUrl, {
          body: rawBody,
          headers,
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
        });
        responseStatus = response.status;
        responseBodyPreview = await readResponsePreview(
          response,
          input.config.responseBodyPreviewBytes,
          controller.signal,
        );
        success = response.status >= 200 && response.status < 300;
        retryable = response.status === 408 ||
          response.status === 409 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        if (!success && !retryable) {
          errorMessage = isRedirectResponse(response)
            ? 'webhook redirect not allowed'
            : `webhook returned HTTP ${response.status}`;
        }
      } finally {
        clearTimeout(timeout);
        inFlightControllers.delete(controller);
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      retryable = isRetryableError(error);
    }

    await input.persistence.insertWebhookDeliveryAttempt({
      id: `whda_${randomUUID().replaceAll('-', '')}`,
      deliveryId: delivery.id,
      attempt: delivery.attemptCount,
      attemptedAt: startedAt,
      durationMs: Math.max(0, now() - startedAt),
      success,
      responseStatus,
      responseBodyPreview,
      errorMessage,
      now: now(),
    });

    if (success) {
      await input.persistence.markWebhookDeliverySucceeded({
        deliveryId: delivery.id,
        responseStatus,
        responseBodyPreview,
        now: now(),
      });
    } else if (retryable && delivery.attemptCount < input.config.maxAttempts) {
      await input.persistence.markWebhookDeliveryRetrying({
        deliveryId: delivery.id,
        nextAttemptAt: now() + calculateBackoff(input.config, delivery.attemptCount),
        responseStatus,
        responseBodyPreview,
        errorMessage,
        now: now(),
      });
    } else {
      await input.persistence.markWebhookDeliveryAbandoned({
        deliveryId: delivery.id,
        responseStatus,
        responseBodyPreview,
        errorMessage,
        now: now(),
      });
    }

    logDeliveryResult({ daemonLogger, delivery, success, responseStatus, errorMessage });
  }

  async function scheduleFromPersistence(): Promise<void> {
    const nextDue = await input.persistence.getNextWebhookDeliveryDueAt({
      lockTimeoutMs: input.config.lockTimeoutMs,
    });
    if (nextDue === null || stopped) return;
    if (nextDue <= now()) {
      scheduleNextDue(now() + minRecheckDelayMs);
      return;
    }
    scheduleNextDue(nextDue);
  }

  function scheduleNextDue(timestamp: number): void {
    if (stopped) return;
    if (nextDueTimerAt !== null && nextDueTimerAt <= timestamp) return;
    clearTimer('nextDue');
    nextDueTimerAt = timestamp;
    nextDueTimerId = timer.setTimeout(() => {
      nextDueTimerId = null;
      nextDueTimerAt = null;
      void drainDue();
    }, Math.max(0, timestamp - now()));
  }

  function clearTimer(kind: 'reconnect' | 'keepalive' | 'nextDue'): void {
    if (kind === 'reconnect' && reconnectTimerId !== null) {
      timer.clearTimeout(reconnectTimerId);
      reconnectTimerId = null;
    }
    if (kind === 'keepalive' && keepaliveTimerId !== null) {
      timer.clearTimeout(keepaliveTimerId);
      keepaliveTimerId = null;
    }
    if (kind === 'nextDue' && nextDueTimerId !== null) {
      timer.clearTimeout(nextDueTimerId);
      nextDueTimerId = null;
      nextDueTimerAt = null;
    }
  }

  return { start, stop, drainDue, recoverDueAndScheduleNext };
}

function parseNotificationPayload(payload: string | undefined): { deliveryId: string; nextAttemptAt: number } {
  const parsed = JSON.parse(payload ?? '');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('webhook notification payload must be an object');
  }
  const value = parsed as { deliveryId?: unknown; nextAttemptAt?: unknown };
  if (typeof value.deliveryId !== 'string' || value.deliveryId.length === 0) {
    throw new Error('webhook notification deliveryId is invalid');
  }
  if (
    typeof value.nextAttemptAt !== 'number' ||
    !Number.isFinite(value.nextAttemptAt) ||
    value.nextAttemptAt < 0
  ) {
    throw new Error('webhook notification nextAttemptAt is invalid');
  }
  return { deliveryId: value.deliveryId, nextAttemptAt: value.nextAttemptAt };
}

function injectDeliveryAttempt(payload: unknown, attempt: number): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), deliveryAttempt: attempt };
  }
  return { schemaVersion: 'daemon.webhook.unknown.v1', deliveryAttempt: attempt, payload };
}

async function readResponsePreview(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string | null> {
  if (maxBytes <= 0) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  let tail: ResponseBodyChunk = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await readResponseChunk(reader, signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      tail = appendBoundedTail(tail, value, maxBytes);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(tail);
}

function appendBoundedTail(
  existing: ResponseBodyChunk,
  next: ResponseBodyChunk,
  maxBytes: number,
): ResponseBodyChunk {
  if (next.byteLength >= maxBytes) {
    return next.slice(next.byteLength - maxBytes);
  }
  const combined = new Uint8Array(Math.min(maxBytes, existing.byteLength + next.byteLength));
  const existingOffset = Math.max(0, existing.byteLength + next.byteLength - maxBytes);
  const existingSlice = existing.slice(existingOffset);
  combined.set(existingSlice, 0);
  combined.set(next, existingSlice.byteLength);
  return combined;
}

async function readResponseChunk(
  reader: ResponseBodyReader,
  signal: AbortSignal,
): Promise<ResponseBodyReadResult> {
  if (signal.aborted) {
    await reader.cancel().catch(() => undefined);
    throw new Error('webhook request timed out');
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new Error('webhook request timed out'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function calculateBackoff(config: WebhookConfig, attempt: number): number {
  const exponential = config.initialBackoffMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(config.maxBackoffMs, exponential);
}

function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    return code !== 'WEBHOOK_URL_NOT_ALLOWED';
  }
  return true;
}

function isRedirectResponse(response: Response): boolean {
  // Some fetch runtimes expose manual redirects as opaque responses with status 0.
  return response.type === 'opaqueredirect' || response.status === 0 ||
    (response.status >= 300 && response.status < 400);
}

function logDeliveryResult(input: {
  daemonLogger: DaemonLogger;
  delivery: WebhookDeliveryJobRecord;
  success: boolean;
  responseStatus: number | null;
  errorMessage: string | null;
}): void {
  input.daemonLogger.info('webhook_delivery_finished', {
    attempt: input.delivery.attemptCount,
    deliveryId: input.delivery.id,
    errorMessage: input.errorMessage,
    payloadSha256: input.delivery.payloadSha256,
    responseStatus: input.responseStatus,
    runId: input.delivery.runId,
    success: input.success,
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('webhook listener keepalive timed out')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

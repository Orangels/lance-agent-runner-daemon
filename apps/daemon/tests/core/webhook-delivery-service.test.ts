import { describe, expect, it, vi } from 'vitest';
import type { WebhookConfig } from '../../src/config/profiles.js';
import type {
  RunnerPersistence,
  WebhookDeliveryJobRecord,
  WebhookDeliveryRecord,
} from '../../src/db/types.js';
import { webhookDeliveryNotifyChannel } from '../../src/db/postgres/repositories.js';
import {
  createWebhookDeliveryService,
  type CreateWebhookDeliveryServiceInput,
} from '../../src/core/webhook-delivery-service.js';
import { signWebhookPayload } from '../../src/core/webhook-signing.js';
import { assertWebhookUrlAllowed } from '../../src/core/webhook-url-policy.js';

function webhookConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    enabled: true,
    allowInsecureHttp: true,
    allowPrivateNetworks: true,
    allowedPrivateCidrs: ['192.168.88.0/24'],
    allowedHosts: [],
    requestTimeoutMs: 5000,
    maxAttempts: 8,
    lockTimeoutMs: 30000,
    initialBackoffMs: 1000,
    maxBackoffMs: 300000,
    listenReconnectBackoffMs: 1000,
    listenKeepaliveMs: 15000,
    listenKeepaliveTimeoutMs: 5000,
    claimLimit: 5,
    maxConcurrentDeliveries: 5,
    stopGraceMs: 10000,
    responseBodyPreviewBytes: 4096,
    ...overrides,
  };
}

function delivery(overrides: Partial<WebhookDeliveryJobRecord> = {}): WebhookDeliveryJobRecord {
  return {
    id: 'whd_1',
    runId: 'run_1',
    webhookId: 'wh_1',
    clientId: 'business-client',
    eventType: 'run.status_changed',
    runStatus: 'succeeded',
    deliveryStatus: 'delivering',
    payload: {
      schemaVersion: 'daemon.webhook.run.v1',
      eventId: 'whd_1',
      eventType: 'run.status_changed',
      deliveryAttempt: 1,
      run: { id: 'run_1', status: 'succeeded' },
    },
    payloadSha256: 'payload_hash',
    attemptCount: 0,
    nextAttemptAt: 1000,
    lockedAt: 1000,
    lockedBy: 'worker',
    lastAttemptAt: null,
    deliveredAt: null,
    responseStatus: null,
    responseBodyPreview: null,
    errorMessage: null,
    createdAt: 1000,
    updatedAt: 1000,
    webhookUrl: 'http://192.168.88.20:8000/webhook',
    webhookSecret: 'webhook-secret',
    ...overrides,
  };
}

function persistenceFixture(input: {
  delivery?: WebhookDeliveryJobRecord;
  attemptCount?: number;
  sequence?: string[];
} = {}) {
  const job = {
    ...(input.delivery ?? delivery()),
    attemptCount: input.attemptCount ?? input.delivery?.attemptCount ?? 1,
  };
  const sequence = input.sequence ?? [];
  const persistence = {
    claimDueWebhookDeliveries: vi.fn(async () => ({ claimed: [job], abandonedIds: [] })),
    getNextWebhookDeliveryDueAt: vi.fn(async () => null),
    markWebhookDeliverySucceeded: vi.fn(async () => ({ ...job, deliveryStatus: 'succeeded' })),
    markWebhookDeliveryRetrying: vi.fn(async () => ({ ...job, deliveryStatus: 'retrying' })),
    markWebhookDeliveryAbandoned: vi.fn(async () => ({ ...job, deliveryStatus: 'abandoned' })),
    insertWebhookDeliveryAttempt: vi.fn(async () => ({
      id: 'whda_1',
      deliveryId: job.id,
      attempt: job.attemptCount,
      attemptedAt: 1000,
      durationMs: 0,
      success: true,
      responseStatus: 200,
      responseBodyPreview: null,
      errorMessage: null,
      createdAt: 1000,
    })),
  } as unknown as RunnerPersistence;
  return { persistence, job, sequence };
}

const lookup = vi.fn(async (hostname: string) => [{ address: hostname, family: 4 }]);
type TestListenerClient = ReturnType<NonNullable<CreateWebhookDeliveryServiceInput['createListenerClient']>>;

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createTimerHarness() {
  let nextId = 1;
  const timers: Array<{ id: number; delayMs: number; callback: () => void; cleared: boolean }> = [];
  return {
    timer: {
      setTimeout: (callback: () => void, delayMs: number) => {
        const task = { id: nextId++, delayMs, callback, cleared: false };
        timers.push(task);
        return task.id;
      },
      clearTimeout: (id: unknown) => {
        const task = timers.find((candidate) => candidate.id === id);
        if (task) task.cleared = true;
      },
    },
    runNextTimer: () => {
      const task = timers
        .filter((candidate) => !candidate.cleared)
        .sort((left, right) => left.delayMs - right.delayMs)[0];
      if (!task) throw new Error('No pending timer');
      task.cleared = true;
      task.callback();
      return task;
    },
    pendingTimers: () => timers.filter((task) => !task.cleared),
  };
}

function createListenerClient(sequence: string[], options: { keepaliveFails?: boolean } = {}) {
  const handlers: {
    notification?: (message: { channel: string; payload?: string }) => void;
    error?: (error?: unknown) => void;
    end?: () => void;
  } = {};
  const client = {
    async connect() {
      sequence.push('connect');
    },
    async end() {
      sequence.push('end');
    },
    async query(sql: string) {
      sequence.push(sql.startsWith('LISTEN') ? 'listen' : sql);
      if (options.keepaliveFails && sql === 'SELECT 1') {
        throw new Error('keepalive failed');
      }
      return {};
    },
    on(event: 'notification' | 'error' | 'end', listener: (message?: unknown) => void) {
      if (event === 'notification') {
        handlers.notification = listener as (message: { channel: string; payload?: string }) => void;
      } else if (event === 'error') {
        handlers.error = listener;
      } else {
        handlers.end = listener as () => void;
      }
      return client;
    },
    emitNotification(payload: unknown) {
      handlers.notification?.({
        channel: webhookDeliveryNotifyChannel,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      });
    },
    emitEnd() {
      handlers.end?.();
    },
  };
  return client;
}

describe('webhook URL policy', () => {
  it('allows configured LAN CIDR targets and rejects unsafe local targets', async () => {
    await expect(
      assertWebhookUrlAllowed({
        url: 'http://192.168.88.20:8000/webhook',
        config: webhookConfig(),
        lookup,
      }),
    ).resolves.toBeInstanceOf(URL);

    await expect(
      assertWebhookUrlAllowed({
        url: 'http://127.0.0.1:8000/webhook',
        config: webhookConfig(),
        lookup,
      }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_URL_NOT_ALLOWED' });
  });

  it('rejects IPv6 and IPv4-mapped IPv6 targets unless the host is explicitly allowed', async () => {
    await expect(
      assertWebhookUrlAllowed({
        url: 'http://business.internal:8000/webhook',
        config: webhookConfig(),
        lookup: vi.fn(async () => [{ address: '::1', family: 6 }]),
      }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_URL_NOT_ALLOWED' });

    await expect(
      assertWebhookUrlAllowed({
        url: 'http://business.internal:8000/webhook',
        config: webhookConfig(),
        lookup: vi.fn(async () => [{ address: '::ffff:127.0.0.1', family: 6 }]),
      }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_URL_NOT_ALLOWED' });

    await expect(
      assertWebhookUrlAllowed({
        url: 'http://business.internal:8000/webhook',
        config: webhookConfig({ allowedHosts: ['business.internal'] }),
        lookup: vi.fn(async () => [{ address: '::1', family: 6 }]),
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('rejects credentials, fragments, non-http protocols, and insecure http when disabled', async () => {
    await expect(
      assertWebhookUrlAllowed({
        url: 'http://user:pass@192.168.88.20:8000/webhook',
        config: webhookConfig(),
        lookup,
      }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_URL_NOT_ALLOWED' });
    await expect(
      assertWebhookUrlAllowed({
        url: 'http://192.168.88.20:8000/webhook#secret',
        config: webhookConfig(),
        lookup,
      }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_URL_NOT_ALLOWED' });
    await expect(
      assertWebhookUrlAllowed({
        url: 'ftp://192.168.88.20/webhook',
        config: webhookConfig(),
        lookup,
      }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_URL_NOT_ALLOWED' });
    await expect(
      assertWebhookUrlAllowed({
        url: 'http://192.168.88.20:8000/webhook',
        config: webhookConfig({ allowInsecureHttp: false }),
        lookup,
      }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_URL_NOT_ALLOWED' });
  });
});

describe('webhook delivery service', () => {
  it('subscribes to LISTEN before startup recovery', async () => {
    const sequence: string[] = [];
    const listener = createListenerClient(sequence);
    const { persistence } = persistenceFixture();
    vi.mocked(persistence.claimDueWebhookDeliveries).mockImplementation(async () => {
      sequence.push('claim');
      return { claimed: [], abandonedIds: [] };
    });
    const service = createWebhookDeliveryService({
      config: webhookConfig(),
      persistence,
      createListenerClient: () => listener as TestListenerClient,
      fetchImpl: vi.fn(),
      lookup,
      timer: createTimerHarness().timer,
    });

    service.start();
    await vi.waitFor(() => expect(sequence).toContain('claim'));

    expect(sequence.slice(0, 3)).toEqual(['connect', 'listen', 'claim']);
  });

  it('uses NOTIFY as a wake-up hint and min-merges future due timers', async () => {
    let now = 2000;
    const sequence: string[] = [];
    const listener = createListenerClient(sequence);
    const timers = createTimerHarness();
    const { persistence } = persistenceFixture();
    vi.mocked(persistence.claimDueWebhookDeliveries).mockResolvedValue({ claimed: [], abandonedIds: [] });
    vi.mocked(persistence.getNextWebhookDeliveryDueAt).mockResolvedValue(null);
    const service = createWebhookDeliveryService({
      config: webhookConfig(),
      persistence,
      createListenerClient: () => listener as TestListenerClient,
      fetchImpl: vi.fn(),
      lookup,
      clock: () => now,
      timer: timers.timer,
    });

    service.start();
    await vi.waitFor(() => expect(persistence.claimDueWebhookDeliveries).toHaveBeenCalledTimes(1));

    listener.emitNotification({ deliveryId: 'whd_future_late', nextAttemptAt: 8000 });
    listener.emitNotification({ deliveryId: 'whd_future_early', nextAttemptAt: 5000 });
    expect(timers.pendingTimers().some((timer) => timer.delayMs === 3000)).toBe(true);
    expect(timers.pendingTimers().some((timer) => timer.delayMs === 6000 && !timer.cleared)).toBe(false);

    now = 5000;
    timers.runNextTimer();
    await vi.waitFor(() => expect(persistence.claimDueWebhookDeliveries).toHaveBeenCalledTimes(2));
  });

  it('reconnects and runs recovery when listener keepalive fails', async () => {
    const sequence: string[] = [];
    const timers = createTimerHarness();
    const clients = [
      createListenerClient(sequence, { keepaliveFails: true }),
      createListenerClient(sequence),
    ];
    const { persistence } = persistenceFixture();
    vi.mocked(persistence.claimDueWebhookDeliveries).mockImplementation(async () => {
      sequence.push('claim');
      return { claimed: [], abandonedIds: [] };
    });
    const service = createWebhookDeliveryService({
      config: webhookConfig({ listenKeepaliveMs: 100, listenReconnectBackoffMs: 250 }),
      persistence,
      createListenerClient: () => clients.shift()! as TestListenerClient,
      fetchImpl: vi.fn(),
      lookup,
      timer: timers.timer,
    });

    service.start();
    await vi.waitFor(() => expect(sequence).toEqual(expect.arrayContaining(['connect', 'listen', 'claim'])));

    timers.runNextTimer();
    await flushAsync();
    expect(sequence).toContain('SELECT 1');

    timers.runNextTimer();
    await vi.waitFor(() => expect(sequence.filter((entry) => entry === 'claim')).toHaveLength(2));
    expect(sequence.slice(-2)).toEqual(['listen', 'claim']);
  });

  it('increments attempt count before fetch, injects deliveryAttempt, and signs payloads', async () => {
    const sequence: string[] = [];
    const { persistence, job } = persistenceFixture({ attemptCount: 2, sequence });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sequence.push('fetch');
      return new Response('ok', { status: 200 });
    });
    const service = createWebhookDeliveryService({
      config: webhookConfig(),
      persistence,
      fetchImpl,
      lookup,
      clock: () => 2000,
      workerId: 'worker_1',
    });

    await service.drainDue();

    expect(sequence).toEqual(['fetch']);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init).toBeDefined();
    const body = String(init!.body);
    expect(JSON.parse(body)).toEqual(expect.objectContaining({ deliveryAttempt: 2 }));
    expect(init!.redirect).toBe('manual');
    expect(init!.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Daemon-Webhook-Id': job.id,
      'X-Daemon-Webhook-Timestamp': '2000',
      'X-Daemon-Webhook-Signature': signWebhookPayload({
        secret: 'webhook-secret',
        timestamp: 2000,
        rawBody: body,
      }),
    });
    expect(persistence.markWebhookDeliverySucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: job.id, responseStatus: 200 }),
    );
    expect(persistence.insertWebhookDeliveryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: job.id, attempt: 2, success: true }),
    );
  });

  it('omits signature header when the webhook has no secret', async () => {
    const { persistence } = persistenceFixture({ delivery: delivery({ webhookSecret: null }) });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response('ok', { status: 200 }),
    );
    const service = createWebhookDeliveryService({
      config: webhookConfig(),
      persistence,
      fetchImpl,
      lookup,
      clock: () => 2000,
    });

    await service.drainDue();

    const firstFetchCall = fetchImpl.mock.calls[0];
    expect(firstFetchCall?.[1]).toBeDefined();
    const headers = firstFetchCall![1]!.headers as Record<string, string>;
    expect(headers['X-Daemon-Webhook-Id']).toBe('whd_1');
    expect(headers['X-Daemon-Webhook-Signature']).toBeUndefined();
  });

  it('abandons unsafe URLs before fetch', async () => {
    const { persistence } = persistenceFixture({
      delivery: delivery({ webhookUrl: 'http://127.0.0.1:8000/webhook' }),
    });
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const service = createWebhookDeliveryService({
      config: webhookConfig(),
      persistence,
      fetchImpl,
      lookup,
      clock: () => 2000,
    });

    await service.drainDue();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(persistence.markWebhookDeliveryAbandoned).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'whd_1', errorMessage: expect.any(String) }),
    );
  });

  it('retries retryable HTTP responses and abandons non-retryable responses', async () => {
    const retrying = persistenceFixture();
    const retryService = createWebhookDeliveryService({
      config: webhookConfig(),
      persistence: retrying.persistence,
      fetchImpl: vi.fn(async () => new Response('retry later', { status: 500 })),
      lookup,
      clock: () => 2000,
    });
    await retryService.drainDue();
    expect(retrying.persistence.markWebhookDeliveryRetrying).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'whd_1', nextAttemptAt: 3000, responseStatus: 500 }),
    );

    const abandoned = persistenceFixture();
    const abandonService = createWebhookDeliveryService({
      config: webhookConfig(),
      persistence: abandoned.persistence,
      fetchImpl: vi.fn(async () => new Response('bad request', { status: 400 })),
      lookup,
      clock: () => 2000,
    });
    await abandonService.drainDue();
    expect(abandoned.persistence.markWebhookDeliveryAbandoned).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'whd_1', responseStatus: 400 }),
    );
  });

  it('applies request timeout while reading a webhook response body', async () => {
    let closeBody = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        closeBody = () => controller.close();
        controller.enqueue(new TextEncoder().encode('partial response'));
      },
    });
    const { persistence } = persistenceFixture();
    const service = createWebhookDeliveryService({
      config: webhookConfig({ requestTimeoutMs: 10 }),
      persistence,
      fetchImpl: vi.fn(async () => new Response(body, { status: 500 })),
      lookup,
      clock: () => 2000,
    });

    const drain = service.drainDue();
    const outcome = await Promise.race([
      drain.then(() => 'resolved'),
      new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 100)),
    ]);
    if (outcome === 'timed out') {
      closeBody();
      await drain.catch(() => undefined);
    }

    expect(outcome).toBe('resolved');
    expect(persistence.markWebhookDeliveryRetrying).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'whd_1', responseStatus: 500 }),
    );
  });

  it('abandons redirects with an explicit diagnostic message', async () => {
    const { persistence } = persistenceFixture();
    const service = createWebhookDeliveryService({
      config: webhookConfig(),
      persistence,
      fetchImpl: vi.fn(async () => new Response(null, {
        headers: { Location: 'http://192.168.88.21/webhook' },
        status: 302,
      })),
      lookup,
      clock: () => 2000,
    });

    await service.drainDue();

    expect(persistence.markWebhookDeliveryAbandoned).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'whd_1',
        errorMessage: 'webhook redirect not allowed',
        responseStatus: 302,
      }),
    );
  });

  it('abandons retryable failures after maxAttempts', async () => {
    const { persistence } = persistenceFixture({ attemptCount: 8 });
    const service = createWebhookDeliveryService({
      config: webhookConfig({ maxAttempts: 8 }),
      persistence,
      fetchImpl: vi.fn(async () => new Response('retry later', { status: 429 })),
      lookup,
      clock: () => 2000,
    });

    await service.drainDue();

    expect(persistence.markWebhookDeliveryRetrying).not.toHaveBeenCalled();
    expect(persistence.markWebhookDeliveryAbandoned).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'whd_1', responseStatus: 429 }),
    );
  });
});

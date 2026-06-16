import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresRunnerPersistence,
  webhookDeliveryNotifyChannel,
} from '../../src/db/postgres/repositories.js';
import { runPostgresMigrations } from '../../src/db/postgres/migrate.js';
import type { RunnerPersistence } from '../../src/db/types.js';
import {
  acquirePostgresTestLock,
  createPostgresTestPool,
  requirePostgresTestUrl,
  resetPostgresSchema,
} from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;

postgresDescribe('postgres runner persistence', () => {
  const databaseUrl = requirePostgresTestUrl()!;
  let releaseTestLock: (() => Promise<void>) | null = null;
  let persistence: RunnerPersistence;
  const pool = createPostgresTestPool(databaseUrl);

  beforeAll(async () => {
    releaseTestLock = await acquirePostgresTestLock(databaseUrl);
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });
    persistence = createPostgresRunnerPersistence({ databaseUrl });
  });

  afterAll(async () => {
    await persistence?.close();
    await pool.end();
    await releaseTestLock?.();
  });

  it('upserts workspaces by client/profile/workspace key', async () => {
    const workspace = await insertWorkspaceFixture(persistence);

    const again = await persistence.upsertWorkspace({
      id: 'ws_ignored',
      clientId: 'client_a',
      profileId: 'report-docx',
      originId: 'origin',
      userId: 'user',
      projectId: 'project',
      metadata: { label: 'updated' },
      now: 2000,
    });
    const otherClient = await persistence.upsertWorkspace({
      id: 'ws_other_client',
      clientId: 'client_b',
      profileId: 'report-docx',
      originId: 'origin',
      userId: 'user',
      projectId: 'project',
      now: 3000,
    });

    expect(again.id).toBe(workspace.id);
    expect(again.metadata).toEqual({ label: 'updated' });
    expect(otherClient.id).toBe('ws_other_client');
    await expect(
      persistence.getWorkspaceForClient({ workspaceId: workspace.id, clientId: 'client_b' }),
    ).resolves.toBeNull();
  });

  it('atomically upserts concurrent workspace creates for the same key', async () => {
    const attempts = Array.from({ length: 20 }, (_, index) =>
      persistence.upsertWorkspace({
        id: `ws_concurrent_${index}`,
        clientId: 'client_concurrent',
        profileId: 'report-docx',
        originId: 'origin',
        userId: 'user',
        projectId: 'project',
        metadata: { attempt: index },
        now: 2000 + index,
      }),
    );

    const workspaces = await Promise.all(attempts);

    expect(new Set(workspaces.map((workspace) => workspace.id)).size).toBe(1);
    const count = await pool.query<{ count: number }>(
      `
      SELECT COUNT(*)::int AS count
      FROM workspaces
      WHERE client_id = $1 AND profile_id = $2 AND workspace_key = $3
      `,
      ['client_concurrent', 'report-docx', 'origin/user/project'],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('serializes concurrent default conversation creation and returns the oldest duplicate', async () => {
    const workspace = await insertWorkspaceFixture(persistence, { id: 'ws_default', now: 4000 });

    const [first, second] = await Promise.all([
      persistence.getOrCreateDefaultConversation({ id: 'conv_first', workspaceId: workspace.id, now: 5000 }),
      persistence.getOrCreateDefaultConversation({ id: 'conv_second', workspaceId: workspace.id, now: 5001 }),
    ]);

    expect(second.id).toBe(first.id);

    await pool.query(
      `
        INSERT INTO conversations (id, workspace_id, title, created_at, updated_at)
        VALUES ('conv_oldest_duplicate', $1, 'Default', 1000, 1000)
      `,
      [workspace.id],
    );

    const oldest = await persistence.getOrCreateDefaultConversation({
      id: 'conv_third',
      workspaceId: workspace.id,
      now: 6000,
    });
    expect(oldest.id).toBe('conv_oldest_duplicate');
  });

  it('rolls back create-run rows when a transactional step fails', async () => {
    const workspace = await insertWorkspaceFixture(persistence, { id: 'ws_rollback', now: 7000 });

    await expect(
      persistence.createRunQueuedWithMessagesAndSnapshot({
        runId: 'run_rollback',
        conversationId: 'conv_rollback',
        userMessageId: 'msg_user_rollback',
        assistantMessageId: 'msg_assistant_rollback',
        workspaceId: workspace.id,
        profileId: workspace.profileId,
        clientId: workspace.clientId,
        kind: 'generate',
        prompt: 'prompt',
        // This cannot be JSON stringified and should force the whole transaction to roll back.
        profileSnapshot: circularValue(),
        now: 8000,
      }),
    ).rejects.toThrow();

    await expect(
      persistence.getRunForClient({ runId: 'run_rollback', clientId: workspace.clientId }),
    ).resolves.toBeNull();
    await expect(
      persistence.getConversationForWorkspace({
        conversationId: 'conv_rollback',
        workspaceId: workspace.id,
      }),
    ).resolves.toBeNull();
  });

  it('maps idempotency unique conflicts and scopes lookup by client/profile/workspace', async () => {
    const workspace = await insertWorkspaceFixture(persistence, { id: 'ws_idem', now: 9000 });
    await persistence.insertRunQueued({
      id: 'run_idem_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'generate',
      prompt: 'prompt',
      idempotencyKey: 'key_1',
      idempotencyFingerprint: 'fingerprint_1',
      now: 10_000,
    });

    await expect(
      persistence.insertRunQueued({
        id: 'run_idem_2',
        workspaceId: workspace.id,
        profileId: workspace.profileId,
        clientId: workspace.clientId,
        kind: 'generate',
        prompt: 'prompt',
        idempotencyKey: 'key_1',
        idempotencyFingerprint: 'fingerprint_1',
        now: 10_001,
      }),
    ).rejects.toSatisfy((error: unknown) => persistence.isUniqueConstraintError(error));

    await expect(
      persistence.getRunByIdempotencyKey({
        clientId: workspace.clientId,
        profileId: workspace.profileId,
        workspaceId: workspace.id,
        idempotencyKey: 'key_1',
      }),
    ).resolves.toMatchObject({ id: 'run_idem_1' });
    await expect(
      persistence.getRunByIdempotencyKey({
        clientId: 'other_client',
        profileId: workspace.profileId,
        workspaceId: workspace.id,
        idempotencyKey: 'key_1',
      }),
    ).resolves.toBeNull();
  });

  it('protects log paths and maps artifact bigint values as numbers', async () => {
    const workspace = await insertWorkspaceFixture(persistence, { id: 'ws_artifacts', now: 11_000 });
    const run = await persistence.insertRunQueued({
      id: 'run_artifacts',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'generate',
      prompt: 'prompt',
      now: 12_000,
    });

    await expect(
      persistence.upsertRunLogPaths({
        runId: run.id,
        stdoutLogPath: '/absolute/stdout.log',
        stderrLogPath: null,
        debugEventsLogPath: null,
        now: 13_000,
      }),
    ).rejects.toThrow('Run log paths must be relative to dataDir');

    const artifacts = await persistence.replaceArtifactsForRun({
      runId: run.id,
      workspaceId: workspace.id,
      artifacts: [
        {
          id: 'artifact_big',
          ruleId: 'report-docx',
          role: 'primary',
          relativePath: 'output/report.docx',
          fileName: 'report.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 4_294_967_296,
          mtime: 1_765_000_000_001,
          sha256: 'abc',
          metadata: { primary: true },
        },
      ],
      now: 14_000,
    });

    expect(artifacts[0]).toMatchObject({
      id: 'artifact_big',
      size: 4_294_967_296,
      mtime: 1_765_000_000_001,
      metadata: { primary: true },
    });
    expect(typeof artifacts[0]?.size).toBe('number');
    expect(typeof artifacts[0]?.mtime).toBe('number');
  });

  it('creates webhook config and de-duplicates deliveries by webhook and status', async () => {
    const workspace = await insertWorkspaceFixture(persistence, { id: 'ws_webhook', now: 15_000 });
    const run = await insertRunFixture(persistence, workspace, { id: 'run_webhook', now: 16_000 });
    const webhook = await persistence.insertRunWebhook({
      id: 'wh_run_webhook',
      runId: run.id,
      clientId: run.clientId,
      url: 'http://192.168.88.20:8000/api/daemon/webhook',
      secret: 'shared-secret',
      statuses: ['queued', 'succeeded'],
      metadata: { businessTaskId: 'task_001' },
      now: 17_000,
    });

    expect(webhook).toMatchObject({
      id: 'wh_run_webhook',
      runId: run.id,
      clientId: run.clientId,
      statuses: ['queued', 'succeeded'],
      metadata: { businessTaskId: 'task_001' },
    });

    const first = await persistence.createWebhookDeliveryForRunStatus({
      id: 'whd_queued_1',
      runId: run.id,
      webhookId: webhook.id,
      clientId: run.clientId,
      eventType: 'run.status_changed',
      runStatus: 'queued',
      payload: { eventId: 'whd_queued_1', run: { id: run.id, status: 'queued' } },
      payloadSha256: 'payload_hash_1',
      nextAttemptAt: 18_000,
      now: 18_000,
    });
    const duplicate = await persistence.createWebhookDeliveryForRunStatus({
      id: 'whd_queued_2',
      runId: run.id,
      webhookId: webhook.id,
      clientId: run.clientId,
      eventType: 'run.status_changed',
      runStatus: 'queued',
      payload: { eventId: 'whd_queued_2', run: { id: run.id, status: 'queued' } },
      payloadSha256: 'payload_hash_2',
      nextAttemptAt: 18_001,
      now: 18_001,
    });

    expect(first).toMatchObject({
      id: 'whd_queued_1',
      deliveryStatus: 'pending',
      attemptCount: 0,
      payload: { eventId: 'whd_queued_1', run: { id: run.id, status: 'queued' } },
    });
    expect(duplicate).toBeNull();

    const count = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM webhook_deliveries WHERE webhook_id = $1 AND run_status = $2',
      [webhook.id, 'queued'],
    );
    expect(count.rows[0]?.count).toBe(1);

    await persistence.markWebhookDeliverySucceeded({
      deliveryId: first!.id,
      responseStatus: 200,
      now: 18_002,
    });
  });

  it('notifies webhook workers when a delivery insert wins', async () => {
    const listener = await pool.connect();
    try {
      const notification = new Promise<{ channel: string; payload?: string }>((resolve) => {
        listener.on('notification', resolve);
      });
      await listener.query(`LISTEN ${webhookDeliveryNotifyChannel}`);

      const workspace = await insertWorkspaceFixture(persistence, { id: 'ws_webhook_notify', now: 18_100 });
      const run = await insertRunFixture(persistence, workspace, { id: 'run_webhook_notify', now: 18_200 });
      const webhook = await persistence.insertRunWebhook({
        id: 'wh_run_webhook_notify',
        runId: run.id,
        clientId: run.clientId,
        url: 'http://192.168.88.20:8000/api/daemon/webhook',
        statuses: ['queued'],
        now: 18_300,
      });

      await persistence.createWebhookDeliveryForRunStatus({
        id: 'whd_notify_insert',
        runId: run.id,
        webhookId: webhook.id,
        clientId: run.clientId,
        eventType: 'run.status_changed',
        runStatus: 'queued',
        payload: { eventId: 'whd_notify_insert' },
        payloadSha256: 'payload_hash_notify',
        nextAttemptAt: 18_400,
        now: 18_400,
      });

      await expect(notification).resolves.toMatchObject({
        channel: webhookDeliveryNotifyChannel,
        payload: JSON.stringify({ deliveryId: 'whd_notify_insert', nextAttemptAt: 18_400 }),
      });

      const retryNotification = waitForNotification(listener, 1_000);
      await persistence.markWebhookDeliveryRetrying({
        deliveryId: 'whd_notify_insert',
        nextAttemptAt: 18_900,
        responseStatus: 500,
        errorMessage: 'temporary failure',
        now: 18_401,
      });
      await expect(retryNotification).resolves.toMatchObject({
        channel: webhookDeliveryNotifyChannel,
        payload: JSON.stringify({ deliveryId: 'whd_notify_insert', nextAttemptAt: 18_900 }),
      });

      const unexpectedSucceededNotification = waitForNotification(listener, 100);
      await persistence.markWebhookDeliverySucceeded({
        deliveryId: 'whd_notify_insert',
        responseStatus: 200,
        now: 18_902,
      });
      await expect(unexpectedSucceededNotification).resolves.toBeNull();

      const unexpectedAbandonedNotification = waitForNotification(listener, 100);
      await persistence.markWebhookDeliveryAbandoned({
        deliveryId: 'whd_notify_insert',
        responseStatus: 400,
        errorMessage: 'business rejected webhook',
        now: 18_903,
      });
      await expect(unexpectedAbandonedNotification).resolves.toBeNull();
    } finally {
      await listener.query(`UNLISTEN ${webhookDeliveryNotifyChannel}`).catch(() => undefined);
      listener.release();
    }
  });

  it('claims due webhook deliveries and reclaims stale delivering rows', async () => {
    const workspace = await insertWorkspaceFixture(persistence, { id: 'ws_webhook_claim', now: 19_000 });
    const run = await insertRunFixture(persistence, workspace, { id: 'run_webhook_claim', now: 20_000 });
    const webhook = await persistence.insertRunWebhook({
      id: 'wh_run_webhook_claim',
      runId: run.id,
      clientId: run.clientId,
      url: 'http://192.168.88.20:8000/api/daemon/webhook',
      statuses: ['running'],
      now: 21_000,
    });
    await persistence.createWebhookDeliveryForRunStatus({
      id: 'whd_running_claim',
      runId: run.id,
      webhookId: webhook.id,
      clientId: run.clientId,
      eventType: 'run.status_changed',
      runStatus: 'running',
      payload: { eventId: 'whd_running_claim' },
      payloadSha256: 'payload_hash_claim',
      nextAttemptAt: 22_000,
      now: 22_000,
    });

    const claimed = await persistence.claimDueWebhookDeliveries({
      now: 30_000,
      staleDeliveringBefore: 0,
      lockedBy: 'worker_a',
      limit: 10,
      maxAttempts: 8,
    });
    expect(claimed.claimed).toHaveLength(1);
    expect(claimed.abandonedIds).toEqual([]);
    expect(claimed.claimed[0]).toMatchObject({
      id: 'whd_running_claim',
      deliveryStatus: 'delivering',
      attemptCount: 1,
      lockedAt: 30_000,
      lockedBy: 'worker_a',
      lastAttemptAt: 30_000,
    });

    await expect(
      persistence.claimDueWebhookDeliveries({
        now: 31_000,
        staleDeliveringBefore: 29_999,
        lockedBy: 'worker_b',
        limit: 10,
        maxAttempts: 8,
      }),
    ).resolves.toMatchObject({ claimed: [], abandonedIds: [] });

    const reclaimed = await persistence.claimDueWebhookDeliveries({
      now: 32_000,
      staleDeliveringBefore: 30_001,
      lockedBy: 'worker_b',
      limit: 10,
      maxAttempts: 8,
    });
    expect(reclaimed.claimed).toHaveLength(1);
    expect(reclaimed.claimed[0]).toMatchObject({
      id: 'whd_running_claim',
      deliveryStatus: 'delivering',
      attemptCount: 2,
      lockedAt: 32_000,
      lockedBy: 'worker_b',
    });
  });

  it('tracks webhook delivery attempts and terminal delivery states', async () => {
    const workspace = await insertWorkspaceFixture(persistence, { id: 'ws_webhook_attempts', now: 23_000 });
    const run = await insertRunFixture(persistence, workspace, { id: 'run_webhook_attempts', now: 24_000 });
    const webhook = await persistence.insertRunWebhook({
      id: 'wh_run_webhook_attempts',
      runId: run.id,
      clientId: run.clientId,
      url: 'http://192.168.88.20:8000/api/daemon/webhook',
      statuses: ['succeeded'],
      now: 25_000,
    });
    const delivery = await persistence.createWebhookDeliveryForRunStatus({
      id: 'whd_attempts',
      runId: run.id,
      webhookId: webhook.id,
      clientId: run.clientId,
      eventType: 'run.status_changed',
      runStatus: 'succeeded',
      payload: { eventId: 'whd_attempts' },
      payloadSha256: 'payload_hash_attempts',
      nextAttemptAt: 26_000,
      now: 26_000,
    });
    expect(delivery).not.toBeNull();

    const claimed = await persistence.claimDueWebhookDeliveries({
      now: 27_000,
      staleDeliveringBefore: 0,
      lockedBy: 'worker_attempts',
      limit: 10,
      maxAttempts: 8,
    });
    const attempting = claimed.claimed[0]!;
    expect(attempting).toMatchObject({
      id: 'whd_attempts',
      attemptCount: 1,
      lastAttemptAt: 27_000,
    });

    const attempt = await persistence.insertWebhookDeliveryAttempt({
      id: 'whda_1',
      deliveryId: 'whd_attempts',
      attempt: attempting.attemptCount,
      attemptedAt: 27_000,
      durationMs: 125,
      success: false,
      responseStatus: 500,
      responseBodyPreview: 'server error',
      errorMessage: 'HTTP 500',
      now: 27_001,
    });
    expect(attempt).toMatchObject({
      deliveryId: 'whd_attempts',
      attempt: 1,
      success: false,
      responseStatus: 500,
    });

    const retrying = await persistence.markWebhookDeliveryRetrying({
      deliveryId: 'whd_attempts',
      nextAttemptAt: 35_000,
      responseStatus: 500,
      responseBodyPreview: 'server error',
      errorMessage: 'HTTP 500',
      now: 27_002,
    });
    expect(retrying).toMatchObject({
      deliveryStatus: 'retrying',
      nextAttemptAt: 35_000,
      lockedAt: null,
      lockedBy: null,
      errorMessage: 'HTTP 500',
    });

    const succeeded = await persistence.markWebhookDeliverySucceeded({
      deliveryId: 'whd_attempts',
      responseStatus: 200,
      responseBodyPreview: 'ok',
      now: 36_000,
    });
    expect(succeeded).toMatchObject({
      deliveryStatus: 'succeeded',
      deliveredAt: 36_000,
      responseStatus: 200,
      errorMessage: null,
    });

    const abandoned = await persistence.markWebhookDeliveryAbandoned({
      deliveryId: 'whd_attempts',
      responseStatus: 400,
      responseBodyPreview: 'bad request',
      errorMessage: 'HTTP 400',
      now: 37_000,
    });
    expect(abandoned).toMatchObject({
      deliveryStatus: 'abandoned',
      responseStatus: 400,
      errorMessage: 'HTTP 400',
    });
  });
});

async function insertWorkspaceFixture(
  persistence: RunnerPersistence,
  options: { id?: string; now?: number } = {},
) {
  return persistence.upsertWorkspace({
    id: options.id ?? 'ws_pg_repo',
    clientId: 'client_a',
    profileId: 'report-docx',
    originId: 'origin',
    userId: 'user',
    projectId: 'project',
    status: 'active',
    metadata: { label: 'Report' },
    now: options.now ?? 1000,
  });
}

async function insertRunFixture(
  persistence: RunnerPersistence,
  workspace: Awaited<ReturnType<typeof insertWorkspaceFixture>>,
  options: { id?: string; now?: number } = {},
) {
  return persistence.insertRunQueued({
    id: options.id ?? 'run_pg_repo',
    workspaceId: workspace.id,
    profileId: workspace.profileId,
    clientId: workspace.clientId,
    kind: 'generate',
    prompt: 'prompt',
    now: options.now ?? 2000,
  });
}

function circularValue(): unknown {
  const value: { self?: unknown } = {};
  value.self = value;
  return value;
}

function waitForNotification(
  listener: {
    on(event: 'notification', handler: (message: { channel: string; payload?: string }) => void): unknown;
    off(event: 'notification', handler: (message: { channel: string; payload?: string }) => void): unknown;
  },
  timeoutMs: number,
): Promise<{ channel: string; payload?: string } | null> {
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const handler = (message: { channel: string; payload?: string }) => {
      clearTimeout(timeout);
      listener.off('notification', handler);
      resolve(message);
    };
    timeout = setTimeout(() => {
      listener.off('notification', handler);
      resolve(null);
    }, timeoutMs);
    listener.on('notification', handler);
  });
}

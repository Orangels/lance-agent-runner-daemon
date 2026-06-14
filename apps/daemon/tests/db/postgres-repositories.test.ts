import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresRunnerPersistence } from '../../src/db/postgres/repositories.js';
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

function circularValue(): unknown {
  const value: { self?: unknown } = {};
  value.self = value;
  return value;
}

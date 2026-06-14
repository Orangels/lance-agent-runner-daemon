import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { migrateSqliteToPostgres } from '../../src/db/migration/sqlite-to-postgres.js';
import { runPostgresMigrations } from '../../src/db/postgres/migrate.js';
import { createPostgresRunnerPersistence } from '../../src/db/postgres/repositories.js';
import {
  createRunQueuedWithMessagesAndSnapshot,
  insertRunQueued,
  upsertWorkspace,
} from '../../src/db/repositories.js';
import { applySchema } from '../../src/db/schema.js';
import {
  acquirePostgresTestLock,
  createPostgresTestPool,
  requirePostgresTestUrl,
  resetPostgresSchema,
} from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;

postgresDescribe('sqlite to postgres migration', () => {
  const databaseUrl = requirePostgresTestUrl()!;
  const pool = createPostgresTestPool(databaseUrl);
  let releaseTestLock: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    releaseTestLock = await acquirePostgresTestLock(databaseUrl);
  });

  afterAll(async () => {
    await pool.end();
    await releaseTestLock?.();
  });

  it('copies daemon rows without mutating the SQLite source file', async () => {
    const sqlitePath = createPopulatedSqliteSource();
    const before = await sourceStats(sqlitePath);
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });

    const result = await migrateSqliteToPostgres({ sqlitePath, databaseUrl });

    expect(result.copied.runs).toBe(1);
    expect(await sourceStats(sqlitePath)).toEqual(before);
    const persistence = createPostgresRunnerPersistence({ databaseUrl });
    try {
      const run = await persistence.getRunForClient({ runId: 'run_1', clientId: 'lqbot' });
      expect(run).toMatchObject({
        id: 'run_1',
        idempotencyKey: 'idem_1',
        idempotencyFingerprint: 'fingerprint_1',
        status: 'queued',
      });
      const detail = await persistence.getRunDetail({ runId: 'run_1', clientId: 'lqbot' });
      expect(detail?.messages.map((message) => message.id)).toEqual(['msg_user', 'msg_assistant']);
    } finally {
      await persistence.close();
    }
  });

  it('dry-runs without writing PostgreSQL rows', async () => {
    const sqlitePath = createPopulatedSqliteSource();
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });

    const result = await migrateSqliteToPostgres({ sqlitePath, databaseUrl, dryRun: true });

    expect(result).toMatchObject({ dryRun: true, copied: { runs: 1 } });
    const count = await pool.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM runs');
    expect(count.rows[0]?.count).toBe(0);
  });

  it('dry-runs the actual PostgreSQL inserts before rolling back', async () => {
    const sqlitePath = createInvalidForeignKeySqliteSource();
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });

    await expect(
      migrateSqliteToPostgres({ sqlitePath, databaseUrl, dryRun: true }),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('refuses to copy into a non-empty PostgreSQL target', async () => {
    const sqlitePath = createPopulatedSqliteSource();
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });
    await migrateSqliteToPostgres({ sqlitePath, databaseUrl });

    await expect(migrateSqliteToPostgres({ sqlitePath, databaseUrl })).rejects.toThrow(
      'PostgreSQL target is not empty',
    );
  });

  it('refuses an active SQLite journal or WAL sidecar', async () => {
    const sqlitePath = createPopulatedSqliteSource();
    writeFileSync(`${sqlitePath}-wal`, 'active');
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });

    await expect(migrateSqliteToPostgres({ sqlitePath, databaseUrl })).rejects.toThrow(
      'SQLite source has active journal/WAL sidecar',
    );
  });

  it('fills current defaults when migrating an old SQLite schema', async () => {
    const sqlitePath = createOldSqliteSource();
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });

    await migrateSqliteToPostgres({ sqlitePath, databaseUrl });

    const run = await pool.query<{
      prompt_mode: string;
      current_prompt: string;
      collection_mode: string;
      prompt_snapshot_persisted: number;
    }>('SELECT prompt_mode, current_prompt, collection_mode, prompt_snapshot_persisted FROM runs WHERE id = $1', [
      'run_old',
    ]);
    expect(run.rows[0]).toEqual({
      prompt_mode: 'legacy',
      current_prompt: 'old prompt',
      collection_mode: 'lite',
      prompt_snapshot_persisted: 0,
    });
  });
});

function createPopulatedSqliteSource(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-sqlite-source-'));
  const sqlitePath = path.join(root, 'runner.sqlite');
  const db = openDatabase(sqlitePath);
  applySchema(db);
  const workspace = upsertWorkspace(db, {
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_123',
    now: 1000,
  });
  createRunQueuedWithMessagesAndSnapshot(db, {
    runId: 'run_1',
    conversationId: 'conv_1',
    userMessageId: 'msg_user',
    assistantMessageId: 'msg_assistant',
    workspaceId: workspace.id,
    profileId: workspace.profileId,
    clientId: workspace.clientId,
    kind: 'generate',
    prompt: 'prompt',
    profileSnapshot: { profileId: 'report-docx' },
    idempotencyKey: 'idem_1',
    idempotencyFingerprint: 'fingerprint_1',
    now: 2000,
  });
  db.close();
  return sqlitePath;
}

function createOldSqliteSource(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-old-sqlite-source-'));
  const sqlitePath = path.join(root, 'runner.sqlite');
  const db = openDatabase(sqlitePath);
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      origin_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      skill_id TEXT,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      queued_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      exit_code INTEGER,
      signal TEXT,
      error_code TEXT,
      error_message TEXT,
      usage_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE run_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      events_json TEXT,
      attachments_json TEXT,
      produced_files_json TEXT,
      run_status TEXT,
      last_run_event_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      role TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      mtime INTEGER,
      sha256 TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE run_logs (
      run_id TEXT PRIMARY KEY,
      stdout_log_path TEXT,
      stderr_log_path TEXT,
      debug_events_log_path TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE profile_snapshots (
      run_id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE run_prompt_snapshots (
      run_id TEXT PRIMARY KEY,
      prompt_snapshot TEXT,
      prompt_snapshot_hash TEXT,
      char_count INTEGER,
      byte_count INTEGER,
      persisted INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE run_skill_snapshots (
      run_id TEXT PRIMARY KEY,
      skill_id TEXT,
      skill_name TEXT,
      skill_description TEXT,
      skill_body_hash TEXT,
      skill_body TEXT,
      side_files_manifest_json TEXT,
      persisted INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE run_context_snapshots (
      run_id TEXT PRIMARY KEY,
      business_context_json TEXT,
      business_context_hash TEXT,
      persisted INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE run_feedback (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO workspaces (
      id, profile_id, client_id, origin_id, user_id, project_id, workspace_key, status, created_at, updated_at
    )
    VALUES ('ws_old', 'report-docx', 'lqbot', 'origin', 'user', 'project', 'origin/user/project', 'active', 1, 1);
    INSERT INTO runs (
      id, workspace_id, profile_id, client_id, kind, status, prompt, queued_at, created_at, updated_at
    )
    VALUES ('run_old', 'ws_old', 'report-docx', 'lqbot', 'generate', 'queued', 'old prompt', 2, 2, 2);
  `);
  db.close();
  return sqlitePath;
}

function createInvalidForeignKeySqliteSource(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-invalid-sqlite-source-'));
  const sqlitePath = path.join(root, 'runner.sqlite');
  const db = openDatabase(sqlitePath);
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      origin_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      skill_id TEXT,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      prompt_mode TEXT NOT NULL,
      current_prompt TEXT,
      context_policy_json TEXT,
      collection_mode TEXT NOT NULL,
      prompt_snapshot_hash TEXT,
      prompt_snapshot_char_count INTEGER,
      prompt_snapshot_byte_count INTEGER,
      prompt_snapshot_persisted INTEGER NOT NULL,
      business_context_hash TEXT,
      artifact_rule_ids_json TEXT,
      idempotency_key TEXT,
      idempotency_fingerprint TEXT,
      last_run_event_id TEXT,
      queued_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      exit_code INTEGER,
      signal TEXT,
      error_code TEXT,
      error_message TEXT,
      usage_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO runs (
      id, workspace_id, profile_id, client_id, kind, status, prompt, prompt_mode,
      collection_mode, prompt_snapshot_persisted, created_at, updated_at
    )
    VALUES (
      'run_missing_workspace', 'ws_missing', 'report-docx', 'lqbot', 'generate',
      'queued', 'prompt', 'legacy', 'lite', 0, 1, 1
    );
  `);
  db.close();
  return sqlitePath;
}

async function sourceStats(filePath: string) {
  expect(existsSync(filePath)).toBe(true);
  const { createHash } = await import('node:crypto');
  const { readFileSync, statSync } = await import('node:fs');
  const stats = statSync(filePath);
  return {
    sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

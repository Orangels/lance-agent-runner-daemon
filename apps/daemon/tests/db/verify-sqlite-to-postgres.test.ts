import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateSqliteToPostgres } from '../../src/db/migration/sqlite-to-postgres.js';
import { verifySqliteToPostgres } from '../../src/db/migration/verify-sqlite-to-postgres.js';
import { runPostgresMigrations } from '../../src/db/postgres/migrate.js';
import {
  applyLegacySqliteSourceSchema,
  createLegacyRunWithMessages,
  createLegacyWorkspace,
  openSqliteSourceDatabase,
} from './sqlite-source-fixtures.js';
import {
  acquirePostgresTestLock,
  createPostgresTestPool,
  requirePostgresTestUrl,
  resetPostgresSchema,
} from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;

postgresDescribe('sqlite to postgres verification', () => {
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

  it('passes for a matching SQLite and PostgreSQL pair', async () => {
    const sqlitePath = createPopulatedSqliteSource();
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });
    await migrateSqliteToPostgres({ sqlitePath, databaseUrl });

    await expect(verifySqliteToPostgres({ sqlitePath, databaseUrl })).resolves.toMatchObject({
      ok: true,
      mismatches: [],
    });
  });

  it('reports count and key mismatches without sensitive row values', async () => {
    const sqlitePath = createPopulatedSqliteSource();
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });
    await migrateSqliteToPostgres({ sqlitePath, databaseUrl });
    await pool.query('DELETE FROM runs WHERE id = $1', ['run_verify']);

    const result = await verifySqliteToPostgres({ sqlitePath, databaseUrl });

    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'runs', kind: 'count' })]),
    );
    expect(JSON.stringify(result)).not.toContain('verify prompt');
  });
});

function createPopulatedSqliteSource(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-verify-sqlite-source-'));
  const sqlitePath = path.join(root, 'runner.sqlite');
  const db = openSqliteSourceDatabase(sqlitePath);
  applyLegacySqliteSourceSchema(db);
  const workspace = createLegacyWorkspace(db, {
    id: 'ws_verify',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_123',
    now: 1000,
  });
  createLegacyRunWithMessages(db, {
    runId: 'run_verify',
    conversationId: 'conv_verify',
    userMessageId: 'msg_verify_user',
    assistantMessageId: 'msg_verify_assistant',
    workspaceId: workspace.id,
    profileId: workspace.profileId,
    clientId: workspace.clientId,
    kind: 'generate',
    prompt: 'verify prompt',
    profileSnapshot: { profileId: 'report-docx' },
    idempotencyKey: 'idem_verify',
    idempotencyFingerprint: 'fingerprint_verify',
    now: 2000,
  });
  db.close();
  return sqlitePath;
}

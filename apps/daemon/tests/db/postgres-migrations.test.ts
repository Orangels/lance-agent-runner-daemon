import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertPostgresSchemaReady,
  postgresMigrationsTable,
  runPostgresMigrations,
} from '../../src/db/postgres/migrate.js';
import {
  acquirePostgresTestLock,
  createPostgresTestPool,
  requirePostgresTestUrl,
  resetPostgresSchema,
} from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;

postgresDescribe('postgres migrations', () => {
  const databaseUrl = requirePostgresTestUrl()!;
  const pool = createPostgresTestPool(databaseUrl);
  let releaseTestLock: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    releaseTestLock = await acquirePostgresTestLock(databaseUrl);
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });
  });

  afterAll(async () => {
    await pool.end();
    await releaseTestLock?.();
  });

  it('creates required tables and indexes', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
      `,
    );

    const tableNames = tables.rows.map((row) => row.table_name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        postgresMigrationsTable,
        'artifacts',
        'conversations',
        'profile_snapshots',
        'run_context_snapshots',
        'run_feedback',
        'run_logs',
        'run_messages',
        'run_prompt_snapshots',
        'run_skill_snapshots',
        'runs',
        'workspaces',
      ]),
    );
    expect(tableNames).not.toContain('run_events');

    const indexes = await pool.query<{ indexname: string }>(
      `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY indexname
      `,
    );

    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'idx_artifacts_run',
        'idx_conversations_workspace',
        'idx_run_feedback_run_created',
        'idx_run_messages_conversation',
        'idx_run_messages_conversation_seq',
        'idx_run_messages_run',
        'idx_runs_idempotency_key',
        'idx_runs_status_created',
        'idx_runs_workspace_created',
        'idx_workspaces_client_profile_key',
        'idx_workspaces_identity',
      ]),
    );
  });

  it('preserves required foreign key actions', async () => {
    const constraints = await pool.query<{
      table_name: string;
      column_name: string;
      foreign_table_name: string;
      delete_rule: string;
    }>(
      `
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
       AND rc.constraint_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
      `,
    );

    expect(constraints.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table_name: 'run_messages',
          column_name: 'conversation_id',
          foreign_table_name: 'conversations',
          delete_rule: 'SET NULL',
        }),
        expect.objectContaining({
          table_name: 'runs',
          column_name: 'workspace_id',
          foreign_table_name: 'workspaces',
          delete_rule: 'CASCADE',
        }),
        expect.objectContaining({
          table_name: 'artifacts',
          column_name: 'run_id',
          foreign_table_name: 'runs',
          delete_rule: 'CASCADE',
        }),
      ]),
    );
  });

  it('preserves defaults and nullability for non-obvious columns', async () => {
    const columns = await pool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `
      SELECT table_name, column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'runs' AND column_name IN ('prompt_mode', 'collection_mode', 'prompt_snapshot_persisted'))
          OR (table_name = 'run_messages' AND column_name = 'thinking_content')
          OR (table_name IN ('run_prompt_snapshots', 'run_skill_snapshots', 'run_context_snapshots') AND column_name = 'persisted')
        )
      `,
    );

    expect(columns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table_name: 'runs',
          column_name: 'prompt_mode',
          is_nullable: 'NO',
          column_default: "'legacy'::text",
        }),
        expect.objectContaining({
          table_name: 'runs',
          column_name: 'collection_mode',
          is_nullable: 'NO',
          column_default: "'lite'::text",
        }),
        expect.objectContaining({
          table_name: 'runs',
          column_name: 'prompt_snapshot_persisted',
          is_nullable: 'NO',
          column_default: '0',
        }),
        expect.objectContaining({
          table_name: 'run_messages',
          column_name: 'thinking_content',
          is_nullable: 'NO',
          column_default: "''::text",
        }),
        expect.objectContaining({
          table_name: 'run_prompt_snapshots',
          column_name: 'persisted',
          is_nullable: 'NO',
          column_default: null,
        }),
        expect.objectContaining({
          table_name: 'run_skill_snapshots',
          column_name: 'persisted',
          is_nullable: 'NO',
          column_default: null,
        }),
        expect.objectContaining({
          table_name: 'run_context_snapshots',
          column_name: 'persisted',
          is_nullable: 'NO',
          column_default: null,
        }),
      ]),
    );
  });

  it('reports schema ready after migrations are applied', async () => {
    await expect(assertPostgresSchemaReady(databaseUrl)).resolves.toBeUndefined();
  });
});

describe('postgres migration preflight', () => {
  it('skips postgres integration tests locally when CLAUDE_RUNNER_TEST_PG_URL is absent', () => {
    if (process.env.CLAUDE_RUNNER_TEST_PG_URL) {
      expect(requirePostgresTestUrl()).toBe(process.env.CLAUDE_RUNNER_TEST_PG_URL);
      return;
    }

    expect(requirePostgresTestUrl()).toBeNull();
  });
});

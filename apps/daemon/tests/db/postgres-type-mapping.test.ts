import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPostgresMigrations } from '../../src/db/postgres/migrate.js';
import {
  acquirePostgresTestLock,
  createPostgresTestPool,
  requirePostgresTestUrl,
  resetPostgresSchema,
} from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;

postgresDescribe('postgres type mapping', () => {
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

  it('returns int8 timestamp and size values as numbers', async () => {
    await pool.query(
      `
      INSERT INTO workspaces (
        id, profile_id, client_id, origin_id, user_id, project_id, workspace_key,
        status, created_at, updated_at
      )
      VALUES ('ws_pg', 'profile', 'client', 'origin', 'user', 'project', 'origin/user/project', 'active', $1, $1)
      `,
      [1_765_000_000_000],
    );
    await pool.query(
      `
      INSERT INTO runs (
        id, workspace_id, profile_id, client_id, kind, status, prompt, created_at, updated_at
      )
      VALUES ('run_pg', 'ws_pg', 'profile', 'client', 'generate', 'queued', 'prompt', $1, $1)
      `,
      [1_765_000_000_000],
    );
    await pool.query(
      `
      INSERT INTO artifacts (
        id, run_id, workspace_id, rule_id, role, relative_path, file_name, size, mtime, created_at
      )
      VALUES ('artifact_pg', 'run_pg', 'ws_pg', 'rule', 'primary', 'output.docx', 'output.docx', $1, $2, $3)
      `,
      [4_294_967_296, 1_765_000_000_001, 1_765_000_000_000],
    );
    await pool.query(
      `
      INSERT INTO run_prompt_snapshots (
        run_id, persisted, created_at
      )
      VALUES ('run_pg', 1, $1)
      `,
      [1_765_000_000_000],
    );

    const rows = await pool.query<{
      run_created_at: number;
      artifact_size: number;
      artifact_mtime: number;
      persisted: number;
    }>(
      `
      SELECT
        runs.created_at AS run_created_at,
        artifacts.size AS artifact_size,
        artifacts.mtime AS artifact_mtime,
        run_prompt_snapshots.persisted AS persisted
      FROM runs
      JOIN artifacts ON artifacts.run_id = runs.id
      JOIN run_prompt_snapshots ON run_prompt_snapshots.run_id = runs.id
      WHERE runs.id = 'run_pg'
      `,
    );

    expect(rows.rows[0]).toEqual({
      run_created_at: 1_765_000_000_000,
      artifact_size: 4_294_967_296,
      artifact_mtime: 1_765_000_000_001,
      persisted: 1,
    });
    expect(typeof rows.rows[0]?.run_created_at).toBe('number');
    expect(typeof rows.rows[0]?.artifact_size).toBe('number');
    expect(typeof rows.rows[0]?.artifact_mtime).toBe('number');
  });
});

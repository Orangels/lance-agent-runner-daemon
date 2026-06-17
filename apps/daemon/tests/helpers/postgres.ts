import type pg from 'pg';
import { createPostgresPool } from '../../src/db/postgres/connection.js';

const testLockKey = 4_210_614;

// File-level PG harnesses share one advisory lock and each holder resets+migrates the schema.
export const postgresTestHookTimeoutMs = 60_000;

export function requirePostgresTestUrl(): string | null {
  const databaseUrl = process.env.CLAUDE_RUNNER_TEST_PG_URL ?? null;
  if (process.env.CI === 'true' && databaseUrl === null) {
    throw new Error('CLAUDE_RUNNER_TEST_PG_URL is required in CI');
  }
  return databaseUrl;
}

export async function resetPostgresSchema(databaseUrl: string): Promise<void> {
  const pool = createPostgresPool({ databaseUrl });
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
  } finally {
    await pool.end();
  }
}

export async function truncatePostgresData(databaseUrl: string): Promise<void> {
  const pool = createPostgresPool({ databaseUrl });
  try {
    const result = await pool.query<{ table_identifier: string }>(
      `
      SELECT format('%I.%I', table_schema, table_name) AS table_identifier
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> 'pgmigrations'
      ORDER BY table_name
      `,
    );
    const tableIdentifiers = result.rows.map((row) => row.table_identifier);
    if (tableIdentifiers.length === 0) {
      return;
    }
    await pool.query(`TRUNCATE TABLE ${tableIdentifiers.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await pool.end();
  }
}

export function createPostgresTestPool(databaseUrl: string): pg.Pool {
  return createPostgresPool({ databaseUrl });
}

export async function acquirePostgresTestLock(databaseUrl: string): Promise<() => Promise<void>> {
  const pool = createPostgresPool({ databaseUrl });
  const client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1)', [testLockKey]);
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [testLockKey]);
    } finally {
      client.release();
      await pool.end();
    }
  };
}

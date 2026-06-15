import { describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../src/db/postgres/connection.js';

describe('createPostgresPool', () => {
  it('uses the configured maximum pool size', async () => {
    const pool = createPostgresPool({
      databaseUrl: 'postgres://user:pass@localhost:5432/lance_agent_daemon',
      poolMax: 4,
    });

    try {
      expect(pool.options.max).toBe(4);
    } finally {
      await pool.end();
    }
  });

  it('defaults the maximum pool size to 10', async () => {
    const pool = createPostgresPool({
      databaseUrl: 'postgres://user:pass@localhost:5432/lance_agent_daemon',
    });

    try {
      expect(pool.options.max).toBe(10);
    } finally {
      await pool.end();
    }
  });
});

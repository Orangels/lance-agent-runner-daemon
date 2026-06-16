import {
  acquirePostgresTestLock,
  requirePostgresTestUrl,
  resetPostgresSchema,
} from './postgres.js';
import { runPostgresMigrations } from '../../src/db/postgres/migrate.js';
import { createPostgresRunnerPersistence } from '../../src/db/postgres/repositories.js';
import type { RunnerPersistence } from '../../src/db/types.js';

export interface PostgresPersistenceHarness {
  databaseUrl: string;
  persistence: RunnerPersistence;
  cleanup(): Promise<void>;
}

export async function createPostgresPersistenceHarness(): Promise<PostgresPersistenceHarness | null> {
  const databaseUrl = requirePostgresTestUrl();
  if (!databaseUrl) {
    return null;
  }
  const releaseLock = await acquirePostgresTestLock(databaseUrl);
  await resetPostgresSchema(databaseUrl);
  await runPostgresMigrations({ databaseUrl, command: 'up' });
  const persistence = createPostgresRunnerPersistence({ databaseUrl });

  return {
    databaseUrl,
    persistence,
    async cleanup(): Promise<void> {
      await persistence.close();
      await releaseLock();
    },
  };
}

import {
  acquirePostgresTestLock,
  requirePostgresTestUrl,
  resetPostgresSchema,
  truncatePostgresData,
} from './postgres.js';
import { runPostgresMigrations } from '../../src/db/postgres/migrate.js';
import { createPostgresRunnerPersistence } from '../../src/db/postgres/repositories.js';
import type { RunnerPersistence } from '../../src/db/types.js';

export interface PostgresPersistenceHarness {
  databaseUrl: string;
  persistence: RunnerPersistence;
  cleanup(): Promise<void>;
}

export interface PostgresFilePersistenceHarness extends PostgresPersistenceHarness {
  resetData(): Promise<void>;
}

export async function createPostgresPersistenceHarness(): Promise<PostgresPersistenceHarness | null> {
  const databaseUrl = requirePostgresTestUrl();
  if (!databaseUrl) {
    return null;
  }
  const releaseLock = await acquirePostgresTestLock(databaseUrl);
  let persistence: RunnerPersistence | null = null;
  try {
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });
    persistence = createPostgresRunnerPersistence({ databaseUrl });
  } catch (error) {
    try {
      await persistence?.close();
    } finally {
      await releaseLock();
    }
    throw error;
  }

  return {
    databaseUrl,
    persistence,
    async cleanup(): Promise<void> {
      try {
        await persistence.close();
      } finally {
        await releaseLock();
      }
    },
  };
}

export async function createPostgresFilePersistenceHarness(): Promise<PostgresFilePersistenceHarness | null> {
  const databaseUrl = requirePostgresTestUrl();
  if (!databaseUrl) {
    return null;
  }
  const releaseLock = await acquirePostgresTestLock(databaseUrl);
  let persistence: RunnerPersistence | null = null;
  try {
    await resetPostgresSchema(databaseUrl);
    await runPostgresMigrations({ databaseUrl, command: 'up' });
    persistence = createPostgresRunnerPersistence({ databaseUrl });
  } catch (error) {
    try {
      await persistence?.close();
    } finally {
      await releaseLock();
    }
    throw error;
  }

  return {
    databaseUrl,
    persistence,
    async resetData(): Promise<void> {
      await truncatePostgresData(databaseUrl);
    },
    async cleanup(): Promise<void> {
      try {
        await persistence.close();
      } finally {
        await releaseLock();
      }
    },
  };
}

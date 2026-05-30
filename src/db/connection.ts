import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type RunnerDatabase = Database.Database;

export const runnerDatabaseFileName = 'runner.sqlite';

export function openDatabase(databasePath: string): RunnerDatabase {
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  return db;
}

export function openRunnerDatabase(dataDir: string): RunnerDatabase {
  return openDatabase(path.join(dataDir, runnerDatabaseFileName));
}

export function openInMemoryDatabase(): RunnerDatabase {
  return openDatabase(':memory:');
}

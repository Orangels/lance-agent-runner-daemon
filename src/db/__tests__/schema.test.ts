import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../connection.js';
import { applySchema } from '../schema.js';

function listNames(db: ReturnType<typeof openInMemoryDatabase>, type: 'table' | 'index'): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
    .all(type)
    .map((row) => (row as { name: string }).name);
}

describe('sqlite schema', () => {
  it('applies schema idempotently', () => {
    const db = openInMemoryDatabase();

    applySchema(db);
    applySchema(db);

    expect(listNames(db, 'table')).toContain('workspaces');
  });

  it('creates all first-version tables', () => {
    const db = openInMemoryDatabase();

    applySchema(db);

    expect(listNames(db, 'table')).toEqual([
      'artifacts',
      'conversations',
      'profile_snapshots',
      'run_logs',
      'run_messages',
      'runs',
      'workspaces',
    ]);
  });

  it('does not create a run_events table', () => {
    const db = openInMemoryDatabase();

    applySchema(db);

    expect(listNames(db, 'table')).not.toContain('run_events');
  });

  it('creates required indexes', () => {
    const db = openInMemoryDatabase();

    applySchema(db);

    expect(listNames(db, 'index')).toEqual(
      expect.arrayContaining([
        'idx_artifacts_run',
        'idx_conversations_workspace',
        'idx_run_messages_conversation',
        'idx_run_messages_run',
        'idx_runs_status_created',
        'idx_runs_workspace_created',
        'idx_workspaces_identity',
        'sqlite_autoindex_artifacts_1',
        'sqlite_autoindex_conversations_1',
        'sqlite_autoindex_profile_snapshots_1',
        'sqlite_autoindex_run_logs_1',
        'sqlite_autoindex_run_messages_1',
        'sqlite_autoindex_runs_1',
        'sqlite_autoindex_workspaces_1',
        'sqlite_autoindex_workspaces_2',
      ]),
    );
  });

  it('enables foreign key enforcement on opened databases', () => {
    const db = openInMemoryDatabase();
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };

    expect(row.foreign_keys).toBe(1);
  });
});

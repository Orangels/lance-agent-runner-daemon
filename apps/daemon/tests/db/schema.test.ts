import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import { applySchema } from '../../src/db/schema.js';

function listNames(db: ReturnType<typeof openInMemoryDatabase>, type: 'table' | 'index'): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
    .all(type)
    .map((row) => (row as { name: string }).name);
}

function listColumns(db: ReturnType<typeof openInMemoryDatabase>, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
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
      'run_context_snapshots',
      'run_feedback',
      'run_logs',
      'run_messages',
      'run_prompt_snapshots',
      'run_skill_snapshots',
      'runs',
      'workspaces',
    ]);
  });

  it('does not create a run_events table', () => {
    const db = openInMemoryDatabase();

    applySchema(db);

    expect(listNames(db, 'table')).not.toContain('run_events');
  });

  it('stores aggregated thinking content on run messages', () => {
    const db = openInMemoryDatabase();

    applySchema(db);

    expect(listColumns(db, 'run_messages')).toContain('thinking_content');
  });

  it('stores prompt, collection, and snapshot metadata on runs', () => {
    const db = openInMemoryDatabase();

    applySchema(db);

    expect(listColumns(db, 'runs')).toEqual(
      expect.arrayContaining([
        'prompt_mode',
        'current_prompt',
        'context_policy_json',
        'collection_mode',
        'prompt_snapshot_hash',
        'prompt_snapshot_char_count',
        'prompt_snapshot_byte_count',
        'prompt_snapshot_persisted',
        'business_context_hash',
      ]),
    );
  });

  it('stores conversation-level sequence on run messages', () => {
    const db = openInMemoryDatabase();

    applySchema(db);

    expect(listColumns(db, 'run_messages')).toContain('conversation_seq');
  });

  it('migrates existing run_messages tables to add thinking content', () => {
    const db = openInMemoryDatabase();
    db.exec(`
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

      INSERT INTO run_messages (
        id, workspace_id, run_id, role, content, position, created_at, updated_at
      )
      VALUES ('msg_1', 'ws_1', 'run_1', 'assistant', 'content', 1, 1, 1);
    `);

    applySchema(db);

    const row = db.prepare('SELECT thinking_content FROM run_messages WHERE id = ?').get('msg_1');
    expect(row).toEqual({ thinking_content: '' });
  });

  it('creates required indexes', () => {
    const db = openInMemoryDatabase();

    applySchema(db);

    expect(listNames(db, 'index')).toEqual(
      expect.arrayContaining([
        'idx_artifacts_run',
        'idx_conversations_workspace',
        'idx_run_messages_conversation',
        'idx_run_messages_conversation_seq',
        'idx_run_messages_run',
        'idx_run_feedback_run_created',
        'idx_runs_status_created',
        'idx_runs_workspace_created',
        'idx_workspaces_client_profile_key',
        'idx_workspaces_identity',
        'sqlite_autoindex_artifacts_1',
        'sqlite_autoindex_conversations_1',
        'sqlite_autoindex_profile_snapshots_1',
        'sqlite_autoindex_run_context_snapshots_1',
        'sqlite_autoindex_run_feedback_1',
        'sqlite_autoindex_run_logs_1',
        'sqlite_autoindex_run_messages_1',
        'sqlite_autoindex_run_prompt_snapshots_1',
        'sqlite_autoindex_run_skill_snapshots_1',
        'sqlite_autoindex_runs_1',
        'sqlite_autoindex_workspaces_1',
      ]),
    );
  });

  it('enables foreign key enforcement on opened databases', () => {
    const db = openInMemoryDatabase();
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };

    expect(row.foreign_keys).toBe(1);
  });
});

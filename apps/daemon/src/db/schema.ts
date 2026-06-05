import type { RunnerDatabase } from './connection.js';

export function applySchema(db: RunnerDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      origin_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_identity
      ON workspaces(origin_id, user_id, project_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_client_profile_key
      ON workspaces(client_id, profile_id, workspace_key);

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_workspace
      ON conversations(workspace_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      skill_id TEXT,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      prompt_mode TEXT NOT NULL DEFAULT 'legacy',
      current_prompt TEXT,
      collection_mode TEXT NOT NULL DEFAULT 'lite',
      prompt_snapshot_hash TEXT,
      prompt_snapshot_char_count INTEGER,
      prompt_snapshot_byte_count INTEGER,
      prompt_snapshot_persisted INTEGER NOT NULL DEFAULT 0,
      business_context_hash TEXT,
      artifact_rule_ids_json TEXT,
      last_run_event_id TEXT,
      queued_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      exit_code INTEGER,
      signal TEXT,
      error_code TEXT,
      error_message TEXT,
      usage_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_runs_workspace_created
      ON runs(workspace_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_runs_status_created
      ON runs(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS run_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      thinking_content TEXT NOT NULL DEFAULT '',
      events_json TEXT,
      attachments_json TEXT,
      produced_files_json TEXT,
      run_status TEXT,
      last_run_event_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_run_messages_run
      ON run_messages(run_id, position);

    CREATE INDEX IF NOT EXISTS idx_run_messages_conversation
      ON run_messages(conversation_id, position);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      role TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      mtime INTEGER,
      sha256 TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_run
      ON artifacts(run_id, role);

    CREATE TABLE IF NOT EXISTS run_logs (
      run_id TEXT PRIMARY KEY,
      stdout_log_path TEXT,
      stderr_log_path TEXT,
      debug_events_log_path TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS profile_snapshots (
      run_id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS run_prompt_snapshots (
      run_id TEXT PRIMARY KEY,
      prompt_snapshot TEXT,
      prompt_snapshot_hash TEXT,
      char_count INTEGER,
      byte_count INTEGER,
      persisted INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS run_skill_snapshots (
      run_id TEXT PRIMARY KEY,
      skill_id TEXT,
      skill_name TEXT,
      skill_description TEXT,
      skill_body_hash TEXT,
      skill_body TEXT,
      side_files_manifest_json TEXT,
      persisted INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS run_context_snapshots (
      run_id TEXT PRIMARY KEY,
      business_context_json TEXT,
      business_context_hash TEXT,
      persisted INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
  `);

  ensureRunMessagesThinkingContentColumn(db);
  ensureRunColumns(db);
}

function ensureRunMessagesThinkingContentColumn(db: RunnerDatabase): void {
  ensureColumn(db, 'run_messages', 'thinking_content', "TEXT NOT NULL DEFAULT ''");
}

function ensureRunColumns(db: RunnerDatabase): void {
  ensureColumn(db, 'runs', 'prompt_mode', "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn(db, 'runs', 'current_prompt', 'TEXT');
  ensureColumn(db, 'runs', 'collection_mode', "TEXT NOT NULL DEFAULT 'lite'");
  ensureColumn(db, 'runs', 'prompt_snapshot_hash', 'TEXT');
  ensureColumn(db, 'runs', 'prompt_snapshot_char_count', 'INTEGER');
  ensureColumn(db, 'runs', 'prompt_snapshot_byte_count', 'INTEGER');
  ensureColumn(db, 'runs', 'prompt_snapshot_persisted', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'runs', 'business_context_hash', 'TEXT');
}

function ensureColumn(
  db: RunnerDatabase,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

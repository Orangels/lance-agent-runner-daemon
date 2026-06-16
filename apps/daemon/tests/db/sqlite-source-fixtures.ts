import Database from 'better-sqlite3';

export type SqliteSourceDatabase = Database.Database;

export interface LegacyWorkspaceFixtureInput {
  id: string;
  clientId: string;
  profileId: string;
  originId: string;
  userId: string;
  projectId: string;
  status?: string;
  metadata?: unknown;
  now: number;
}

export interface LegacyWorkspaceFixture {
  id: string;
  clientId: string;
  profileId: string;
  originId: string;
  userId: string;
  projectId: string;
  workspaceKey: string;
  status: string;
  metadata: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface LegacyRunWithMessagesFixtureInput {
  runId: string;
  conversationId?: string;
  defaultConversationId?: string;
  userMessageId: string;
  assistantMessageId: string;
  workspaceId: string;
  profileId: string;
  clientId: string;
  kind: 'generate' | 'revise';
  skillId?: string;
  prompt: string;
  promptMode?: 'legacy' | 'structured';
  currentPrompt?: string | null;
  contextPolicy?: unknown;
  collectionMode?: 'lite' | 'standard';
  businessContext?: unknown;
  businessContextHash?: string | null;
  persistBusinessContext?: boolean;
  artifactRuleIds?: string[];
  idempotencyKey?: string | null;
  idempotencyFingerprint?: string | null;
  metadata?: unknown;
  profileSnapshot: unknown;
  now: number;
}

export function openSqliteSourceDatabase(filename = ':memory:'): SqliteSourceDatabase {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  return db;
}

// Frozen legacy source schema for SQLite-to-PostgreSQL migration tests.
// Do not import runtime SQLite schema here; this fixture intentionally models old source files.
export function applyLegacySqliteSourceSchema(db: SqliteSourceDatabase): void {
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
      context_policy_json TEXT,
      collection_mode TEXT NOT NULL DEFAULT 'lite',
      prompt_snapshot_hash TEXT,
      prompt_snapshot_char_count INTEGER,
      prompt_snapshot_byte_count INTEGER,
      prompt_snapshot_persisted INTEGER NOT NULL DEFAULT 0,
      business_context_hash TEXT,
      artifact_rule_ids_json TEXT,
      idempotency_key TEXT,
      idempotency_fingerprint TEXT,
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency_key
      ON runs(client_id, profile_id, workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

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
      conversation_seq INTEGER,
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

    CREATE INDEX IF NOT EXISTS idx_run_messages_conversation_seq
      ON run_messages(conversation_id, conversation_seq);

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

    CREATE TABLE IF NOT EXISTS run_feedback (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_run_feedback_run_created
      ON run_feedback(run_id, created_at);
  `);
}

export function createLegacyWorkspace(
  db: SqliteSourceDatabase,
  input: LegacyWorkspaceFixtureInput,
): LegacyWorkspaceFixture {
  const workspaceKey = `${input.originId}/${input.userId}/${input.projectId}`;
  const status = input.status ?? 'active';
  db.prepare(
    `
    INSERT INTO workspaces (
      id, profile_id, client_id, origin_id, user_id, project_id, workspace_key,
      status, metadata_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.id,
    input.profileId,
    input.clientId,
    input.originId,
    input.userId,
    input.projectId,
    workspaceKey,
    status,
    stringifyNullable(input.metadata),
    input.now,
    input.now,
  );

  return {
    id: input.id,
    clientId: input.clientId,
    profileId: input.profileId,
    originId: input.originId,
    userId: input.userId,
    projectId: input.projectId,
    workspaceKey,
    status,
    metadata: input.metadata ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function createLegacyRunWithMessages(
  db: SqliteSourceDatabase,
  input: LegacyRunWithMessagesFixtureInput,
): void {
  const create = db.transaction(() => {
    const conversationId =
      input.conversationId && input.defaultConversationId
        ? getConversationForWorkspace(db, {
            conversationId: input.conversationId,
            workspaceId: input.workspaceId,
          })
        : getOrCreateDefaultConversation(db, {
            id: input.defaultConversationId ?? input.conversationId ?? 'conv_default',
            workspaceId: input.workspaceId,
            now: input.now,
          });

    insertLegacyRunQueued(db, input);
    insertLegacyRunMessagesForCreate(db, {
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      workspaceId: input.workspaceId,
      conversationId,
      runId: input.runId,
      prompt: input.currentPrompt ?? input.prompt,
      now: input.now,
    });
    insertProfileSnapshot(db, {
      runId: input.runId,
      profile: input.profileSnapshot,
      now: input.now,
    });

    if (input.businessContextHash) {
      upsertRunContextSnapshot(db, {
        runId: input.runId,
        businessContext: input.persistBusinessContext ? input.businessContext : null,
        businessContextHash: input.businessContextHash,
        persisted: Boolean(input.persistBusinessContext),
        now: input.now,
      });
    }
  });

  create();
}

function getConversationForWorkspace(
  db: SqliteSourceDatabase,
  input: { conversationId: string; workspaceId: string },
): string {
  const existing = db
    .prepare('SELECT id FROM conversations WHERE id = ? AND workspace_id = ?')
    .get(input.conversationId, input.workspaceId) as { id: string } | undefined;
  if (!existing) {
    throw new Error('Repository caller must validate conversation ownership before insert');
  }
  return existing.id;
}

function getOrCreateDefaultConversation(
  db: SqliteSourceDatabase,
  input: { id: string; workspaceId: string; now: number },
): string {
  const existing = db
    .prepare('SELECT id FROM conversations WHERE workspace_id = ? AND title = ? ORDER BY created_at LIMIT 1')
    .get(input.workspaceId, 'Default') as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }

  db.prepare(
    `
    INSERT INTO conversations (id, workspace_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    `,
  ).run(input.id, input.workspaceId, 'Default', input.now, input.now);
  return input.id;
}

function insertLegacyRunQueued(
  db: SqliteSourceDatabase,
  input: LegacyRunWithMessagesFixtureInput,
): void {
  db.prepare(
    `
    INSERT INTO runs (
      id, workspace_id, profile_id, client_id, kind, skill_id, status, prompt,
      prompt_mode, current_prompt, context_policy_json, collection_mode, prompt_snapshot_hash,
      prompt_snapshot_char_count, prompt_snapshot_byte_count, prompt_snapshot_persisted,
      business_context_hash, artifact_rule_ids_json, idempotency_key, idempotency_fingerprint,
      queued_at, metadata_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.runId,
    input.workspaceId,
    input.profileId,
    input.clientId,
    input.kind,
    input.skillId ?? null,
    'queued',
    input.prompt,
    input.promptMode ?? 'legacy',
    input.currentPrompt ?? input.prompt,
    stringifyNullable(input.contextPolicy),
    input.collectionMode ?? 'lite',
    null,
    null,
    null,
    0,
    input.businessContextHash ?? null,
    stringifyNullable(input.artifactRuleIds),
    input.idempotencyKey ?? null,
    input.idempotencyFingerprint ?? null,
    input.now,
    stringifyNullable(input.metadata),
    input.now,
    input.now,
  );
}

function insertLegacyRunMessagesForCreate(
  db: SqliteSourceDatabase,
  input: {
    userMessageId: string;
    assistantMessageId: string;
    workspaceId: string;
    conversationId: string;
    runId: string;
    prompt: string;
    now: number;
  },
): void {
  const userConversationSeq = nextConversationSeq(db, input.conversationId);
  const assistantConversationSeq = userConversationSeq + 1;
  const insert = db.prepare(
    `
    INSERT INTO run_messages (
      id, workspace_id, conversation_id, run_id, role, content, thinking_content,
      run_status, position, conversation_seq, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  insert.run(
    input.userMessageId,
    input.workspaceId,
    input.conversationId,
    input.runId,
    'user',
    input.prompt,
    '',
    null,
    0,
    userConversationSeq,
    input.now,
    input.now,
  );
  insert.run(
    input.assistantMessageId,
    input.workspaceId,
    input.conversationId,
    input.runId,
    'assistant',
    '',
    '',
    'queued',
    1,
    assistantConversationSeq,
    input.now,
    input.now,
  );
}

function insertProfileSnapshot(
  db: SqliteSourceDatabase,
  input: { runId: string; profile: unknown; now: number },
): void {
  db.prepare(
    `
    INSERT INTO profile_snapshots (run_id, profile_json, created_at)
    VALUES (?, ?, ?)
    `,
  ).run(input.runId, JSON.stringify(input.profile), input.now);
}

function upsertRunContextSnapshot(
  db: SqliteSourceDatabase,
  input: {
    runId: string;
    businessContext: unknown;
    businessContextHash: string | null;
    persisted: boolean;
    now: number;
  },
): void {
  db.prepare(
    `
    INSERT INTO run_context_snapshots (
      run_id, business_context_json, business_context_hash, persisted, created_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      business_context_json = excluded.business_context_json,
      business_context_hash = excluded.business_context_hash,
      persisted = excluded.persisted
    `,
  ).run(
    input.runId,
    stringifyNullable(input.businessContext),
    input.businessContextHash,
    input.persisted ? 1 : 0,
    input.now,
  );
}

function nextConversationSeq(db: SqliteSourceDatabase, conversationId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(conversation_seq), 0) AS maxSeq FROM run_messages WHERE conversation_id = ?')
    .get(conversationId) as { maxSeq: number };
  return row.maxSeq + 1;
}

function stringifyNullable(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

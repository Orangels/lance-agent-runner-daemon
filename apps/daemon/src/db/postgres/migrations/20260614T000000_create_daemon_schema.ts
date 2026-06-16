import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE workspaces (
      id text PRIMARY KEY,
      profile_id text NOT NULL,
      client_id text NOT NULL,
      origin_id text NOT NULL,
      user_id text NOT NULL,
      project_id text NOT NULL,
      workspace_key text NOT NULL,
      status text NOT NULL,
      metadata_json text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    );

    CREATE INDEX idx_workspaces_identity
      ON workspaces (origin_id, user_id, project_id);

    CREATE UNIQUE INDEX idx_workspaces_client_profile_key
      ON workspaces (client_id, profile_id, workspace_key);

    CREATE TABLE conversations (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    );

    CREATE INDEX idx_conversations_workspace
      ON conversations (workspace_id, updated_at DESC);

    CREATE TABLE runs (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      profile_id text NOT NULL,
      client_id text NOT NULL,
      kind text NOT NULL,
      skill_id text,
      status text NOT NULL,
      prompt text NOT NULL,
      prompt_mode text NOT NULL DEFAULT 'legacy',
      current_prompt text,
      context_policy_json text,
      collection_mode text NOT NULL DEFAULT 'lite',
      prompt_snapshot_hash text,
      prompt_snapshot_char_count integer,
      prompt_snapshot_byte_count integer,
      prompt_snapshot_persisted integer NOT NULL DEFAULT 0,
      business_context_hash text,
      artifact_rule_ids_json text,
      idempotency_key text,
      idempotency_fingerprint text,
      last_run_event_id text,
      queued_at bigint,
      started_at bigint,
      finished_at bigint,
      exit_code integer,
      signal text,
      error_code text,
      error_message text,
      usage_json text,
      metadata_json text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    );

    CREATE INDEX idx_runs_workspace_created
      ON runs (workspace_id, created_at DESC);

    CREATE INDEX idx_runs_status_created
      ON runs (status, created_at DESC);

    CREATE UNIQUE INDEX idx_runs_idempotency_key
      ON runs (client_id, profile_id, workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE run_messages (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      conversation_id text REFERENCES conversations(id) ON DELETE SET NULL,
      run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      role text NOT NULL,
      content text NOT NULL,
      thinking_content text NOT NULL DEFAULT '',
      events_json text,
      attachments_json text,
      produced_files_json text,
      run_status text,
      last_run_event_id text,
      started_at bigint,
      ended_at bigint,
      position integer NOT NULL,
      conversation_seq integer,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    );

    CREATE INDEX idx_run_messages_run
      ON run_messages (run_id, position);

    CREATE INDEX idx_run_messages_conversation
      ON run_messages (conversation_id, position);

    CREATE INDEX idx_run_messages_conversation_seq
      ON run_messages (conversation_id, conversation_seq);

    CREATE TABLE artifacts (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      rule_id text NOT NULL,
      role text NOT NULL,
      relative_path text NOT NULL,
      file_name text NOT NULL,
      mime_type text,
      size bigint,
      mtime bigint,
      sha256 text,
      metadata_json text,
      created_at bigint NOT NULL
    );

    CREATE INDEX idx_artifacts_run
      ON artifacts (run_id, role);

    CREATE TABLE run_logs (
      run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      stdout_log_path text,
      stderr_log_path text,
      debug_events_log_path text,
      created_at bigint NOT NULL
    );

    CREATE TABLE profile_snapshots (
      run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      profile_json text NOT NULL,
      created_at bigint NOT NULL
    );

    CREATE TABLE run_prompt_snapshots (
      run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      prompt_snapshot text,
      prompt_snapshot_hash text,
      char_count integer,
      byte_count integer,
      persisted integer NOT NULL,
      created_at bigint NOT NULL
    );

    CREATE TABLE run_skill_snapshots (
      run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      skill_id text,
      skill_name text,
      skill_description text,
      skill_body_hash text,
      skill_body text,
      side_files_manifest_json text,
      persisted integer NOT NULL,
      created_at bigint NOT NULL
    );

    CREATE TABLE run_context_snapshots (
      run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      business_context_json text,
      business_context_hash text,
      persisted integer NOT NULL,
      created_at bigint NOT NULL
    );

    CREATE TABLE run_feedback (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      client_id text NOT NULL,
      category text NOT NULL,
      message text NOT NULL,
      metadata_json text,
      created_at bigint NOT NULL
    );

    CREATE INDEX idx_run_feedback_run_created
      ON run_feedback (run_id, created_at);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    DROP TABLE IF EXISTS run_feedback;
    DROP TABLE IF EXISTS run_context_snapshots;
    DROP TABLE IF EXISTS run_skill_snapshots;
    DROP TABLE IF EXISTS run_prompt_snapshots;
    DROP TABLE IF EXISTS profile_snapshots;
    DROP TABLE IF EXISTS run_logs;
    DROP TABLE IF EXISTS artifacts;
    DROP TABLE IF EXISTS run_messages;
    DROP TABLE IF EXISTS runs;
    DROP TABLE IF EXISTS conversations;
    DROP TABLE IF EXISTS workspaces;
  `);
}

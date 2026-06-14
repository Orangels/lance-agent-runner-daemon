import crypto from 'node:crypto';
import path from 'node:path';
import type pg from 'pg';
import type {
  ArtifactRole,
  CollectionMode,
  ContextPolicy,
  PromptMode,
  RunKind,
  RunStatus,
} from '../../core/run-types.js';
import type { PostgresClient, PostgresPool } from './connection.js';
import { createPostgresPool } from './connection.js';
import { isPostgresUniqueConstraintError } from './errors.js';
import type {
  ArtifactRecord,
  ConversationRecord,
  CreateRunQueuedWithMessagesAndSnapshotInput,
  CreateRunQueuedWithMessagesAndSnapshotResult,
  GetArtifactForRunForClientInput,
  GetConversationForWorkspaceInput,
  GetOrCreateDefaultConversationInput,
  GetRunByIdempotencyKeyInput,
  GetRunLogForRunForClientInput,
  GetWorkspaceForClientInput,
  InsertAssistantRunMessageInput,
  InsertRunFeedbackInput,
  InsertRunMessagesForRunCreateInput,
  InsertRunQueuedInput,
  ListArtifactsForRunInput,
  ListConversationMessagesForPromptInput,
  ListRunFeedbackForClientInput,
  ListRunLogsFinishedBeforeInput,
  ListRunsForClientInput,
  ProfileSnapshotRecord,
  ReplaceArtifactsForRunInput,
  RunContextSnapshotRecord,
  RunDetailRecord,
  RunFeedbackRecord,
  RunForClientInput,
  RunLogRecord,
  RunMessageRecord,
  RunnerPersistence,
  RunPromptSnapshotRecord,
  RunRecord,
  RunSkillSnapshotRecord,
  RunWithWorkspaceRecord,
  UpdateAssistantMessageStartedInput,
  UpdateAssistantMessagesTerminalForRunInput,
  UpdateAssistantMessageTerminalInput,
  UpdateRunMessageInput,
  UpdateRunPromptSnapshotFieldsInput,
  UpdateRunStartedInput,
  UpdateRunTerminalInput,
  UpsertRunContextSnapshotInput,
  UpsertRunLogPathsInput,
  UpsertRunPromptSnapshotInput,
  UpsertRunSkillSnapshotInput,
  UpsertWorkspaceInput,
  WorkspaceRecord,
} from '../types.js';

interface CreatePostgresRunnerPersistenceInput {
  databaseUrl?: string;
  pool?: PostgresPool;
}

interface WorkspaceRow {
  id: string;
  profile_id: string;
  client_id: string;
  origin_id: string;
  user_id: string;
  project_id: string;
  workspace_key: string;
  status: string;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ConversationRow {
  id: string;
  workspace_id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  workspace_id: string;
  profile_id: string;
  client_id: string;
  kind: RunKind;
  skill_id: string | null;
  status: RunStatus;
  prompt: string;
  prompt_mode: PromptMode;
  current_prompt: string | null;
  context_policy_json: string | null;
  collection_mode: CollectionMode;
  prompt_snapshot_hash: string | null;
  prompt_snapshot_char_count: number | null;
  prompt_snapshot_byte_count: number | null;
  prompt_snapshot_persisted: number;
  business_context_hash: string | null;
  artifact_rule_ids_json: string | null;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  last_run_event_id: string | null;
  queued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  signal: string | null;
  error_code: string | null;
  error_message: string | null;
  usage_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface RunMessageRow {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  run_id: string;
  role: string;
  content: string;
  thinking_content: string;
  events_json: string | null;
  attachments_json: string | null;
  produced_files_json: string | null;
  run_status: string | null;
  last_run_event_id: string | null;
  started_at: number | null;
  ended_at: number | null;
  position: number;
  conversation_seq: number | null;
  created_at: number;
  updated_at: number;
}

interface ProfileSnapshotRow {
  run_id: string;
  profile_json: string;
  created_at: number;
}

interface RunPromptSnapshotRow {
  run_id: string;
  prompt_snapshot: string | null;
  prompt_snapshot_hash: string | null;
  char_count: number | null;
  byte_count: number | null;
  persisted: number;
  created_at: number;
}

interface RunSkillSnapshotRow {
  run_id: string;
  skill_id: string | null;
  skill_name: string | null;
  skill_description: string | null;
  skill_body_hash: string | null;
  skill_body: string | null;
  side_files_manifest_json: string | null;
  persisted: number;
  created_at: number;
}

interface RunContextSnapshotRow {
  run_id: string;
  business_context_json: string | null;
  business_context_hash: string | null;
  persisted: number;
  created_at: number;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  workspace_id: string;
  rule_id: string;
  role: string;
  relative_path: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
  metadata_json: string | null;
  created_at: number;
}

interface RunLogRow {
  run_id: string;
  stdout_log_path: string | null;
  stderr_log_path: string | null;
  debug_events_log_path: string | null;
  created_at: number;
}

interface RunFeedbackRow {
  id: string;
  run_id: string;
  client_id: string;
  category: string;
  message: string;
  metadata_json: string | null;
  created_at: number;
}

type Queryable = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
};

export function createPostgresRunnerPersistence(
  input: CreatePostgresRunnerPersistenceInput,
): RunnerPersistence {
  if (!input.pool && !input.databaseUrl) {
    throw new Error('databaseUrl or pool is required to create PostgreSQL persistence');
  }
  const pool = input.pool ?? createPostgresPool({ databaseUrl: input.databaseUrl! });
  return new PostgresRunnerPersistence(pool, true);
}

export function makeWorkspaceKey(originId: string, userId: string, projectId: string): string {
  return `${originId}/${userId}/${projectId}`;
}

class PostgresRunnerPersistence implements RunnerPersistence {
  constructor(
    private readonly client: PostgresClient,
    private readonly ownsClient: boolean,
  ) {}

  async close(): Promise<void> {
    if (this.ownsClient && isPool(this.client)) {
      await this.client.end();
    }
  }

  isUniqueConstraintError(error: unknown): boolean {
    return isPostgresUniqueConstraintError(error);
  }

  async transaction<T>(fn: (persistence: RunnerPersistence) => Promise<T>): Promise<T> {
    if (!isPool(this.client)) {
      return fn(this);
    }

    const client = await this.client.connect();
    const persistence = new PostgresRunnerPersistence(client, false);
    try {
      await client.query('BEGIN');
      const result = await fn(persistence);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertWorkspace(input: UpsertWorkspaceInput): Promise<WorkspaceRecord> {
    const workspaceKey = makeWorkspaceKey(input.originId, input.userId, input.projectId);
    const result = await this.client.query<WorkspaceRow>(
      `
      INSERT INTO workspaces (
        id, profile_id, client_id, origin_id, user_id, project_id, workspace_key,
        status, metadata_json, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (client_id, profile_id, workspace_key) DO UPDATE SET
        status = COALESCE($13::text, workspaces.status),
        metadata_json = CASE
          WHEN $12::boolean THEN EXCLUDED.metadata_json
          ELSE workspaces.metadata_json
        END,
        updated_at = EXCLUDED.updated_at
      RETURNING *
      `,
      [
        input.id,
        input.profileId,
        input.clientId,
        input.originId,
        input.userId,
        input.projectId,
        workspaceKey,
        input.status ?? 'active',
        stringifyNullable(input.metadata),
        input.now,
        input.now,
        input.metadata !== undefined,
        input.status ?? null,
      ],
    );

    return mapWorkspace(result.rows[0]!);
  }

  async getWorkspaceForClient(input: GetWorkspaceForClientInput): Promise<WorkspaceRecord | null> {
    const row = input.isAdmin
      ? await maybeOne<WorkspaceRow>(this.client, 'SELECT * FROM workspaces WHERE id = $1', [
          input.workspaceId,
        ])
      : await maybeOne<WorkspaceRow>(
          this.client,
          'SELECT * FROM workspaces WHERE id = $1 AND client_id = $2',
          [input.workspaceId, input.clientId],
        );
    return row ? mapWorkspace(row) : null;
  }

  async getOrCreateDefaultConversation(
    input: GetOrCreateDefaultConversationInput,
  ): Promise<ConversationRecord> {
    if (isPool(this.client)) {
      return this.transaction((tx) => tx.getOrCreateDefaultConversation(input));
    }

    const [key1, key2] = advisoryLockKeys(input.workspaceId);
    await this.client.query('SELECT pg_advisory_xact_lock($1, $2)', [key1, key2]);

    const existing = await maybeOne<ConversationRow>(
      this.client,
      `
      SELECT *
      FROM conversations
      WHERE workspace_id = $1 AND title = $2
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [input.workspaceId, 'Default'],
    );
    if (existing) {
      return mapConversation(existing);
    }

    await this.client.query(
      `
      INSERT INTO conversations (id, workspace_id, title, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [input.id, input.workspaceId, 'Default', input.now, input.now],
    );
    return this.getConversationById(input.id);
  }

  async getConversationForWorkspace(
    input: GetConversationForWorkspaceInput,
  ): Promise<ConversationRecord | null> {
    const row = await maybeOne<ConversationRow>(
      this.client,
      'SELECT * FROM conversations WHERE id = $1 AND workspace_id = $2',
      [input.conversationId, input.workspaceId],
    );
    return row ? mapConversation(row) : null;
  }

  async listConversationMessagesForPrompt(
    input: ListConversationMessagesForPromptInput,
  ): Promise<RunMessageRecord[]> {
    if (input.limit <= 0) return [];

    const result = await this.client.query<RunMessageRow>(
      `
      SELECT * FROM (
        SELECT *
        FROM run_messages
        WHERE workspace_id = $1
          AND conversation_id = $2
          AND content <> ''
          AND ($3::text IS NULL OR run_id <> $3)
        ORDER BY conversation_seq DESC, created_at DESC, id DESC
        LIMIT $4
      ) messages
      ORDER BY conversation_seq ASC, created_at ASC, id ASC
      `,
      [input.workspaceId, input.conversationId, input.excludeRunId ?? null, input.limit],
    );
    return result.rows.map(mapRunMessage);
  }

  async insertRunQueued(input: InsertRunQueuedInput): Promise<RunRecord> {
    await this.client.query(
      `
      INSERT INTO runs (
        id, workspace_id, profile_id, client_id, kind, skill_id, status, prompt,
        prompt_mode, current_prompt, context_policy_json, collection_mode, prompt_snapshot_hash,
        prompt_snapshot_char_count, prompt_snapshot_byte_count, prompt_snapshot_persisted,
        business_context_hash, artifact_rule_ids_json, idempotency_key, idempotency_fingerprint,
        queued_at, metadata_json, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13,
        $14, $15, $16,
        $17, $18, $19, $20,
        $21, $22, $23, $24
      )
      `,
      [
        input.id,
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
        input.promptSnapshotHash ?? null,
        input.promptSnapshotCharCount ?? null,
        input.promptSnapshotByteCount ?? null,
        input.promptSnapshotPersisted ? 1 : 0,
        input.businessContextHash ?? null,
        stringifyNullable(input.artifactRuleIds),
        input.idempotencyKey ?? null,
        input.idempotencyFingerprint ?? null,
        input.now,
        stringifyNullable(input.metadata),
        input.now,
        input.now,
      ],
    );
    return this.getRunById(input.id);
  }

  async createRunQueuedWithMessagesAndSnapshot(
    input: CreateRunQueuedWithMessagesAndSnapshotInput,
  ): Promise<CreateRunQueuedWithMessagesAndSnapshotResult> {
    return this.transaction(async (tx) => {
      const conversation =
        input.conversationId && input.defaultConversationId
          ? await tx.getConversationForWorkspace({
              conversationId: input.conversationId,
              workspaceId: input.workspaceId,
            })
          : await tx.getOrCreateDefaultConversation({
              id: input.defaultConversationId ?? input.conversationId ?? 'conv_default',
              workspaceId: input.workspaceId,
              now: input.now,
            });

      if (!conversation) {
        throw new Error('Repository caller must validate conversation ownership before insert');
      }

      const run = await tx.insertRunQueued({
        id: input.runId,
        workspaceId: input.workspaceId,
        profileId: input.profileId,
        clientId: input.clientId,
        kind: input.kind,
        skillId: input.skillId,
        prompt: input.prompt,
        promptMode: input.promptMode,
        currentPrompt: input.currentPrompt,
        contextPolicy: input.contextPolicy,
        collectionMode: input.collectionMode,
        businessContextHash: input.businessContextHash,
        artifactRuleIds: input.artifactRuleIds,
        idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: input.idempotencyFingerprint,
        metadata: input.metadata,
        now: input.now,
      });
      const messages = await tx.insertRunMessagesForRunCreate({
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        runId: input.runId,
        prompt: input.currentPrompt ?? input.prompt,
        now: input.now,
      });
      const profileSnapshot = await this.insertProfileSnapshot(tx, {
        runId: input.runId,
        profile: input.profileSnapshot,
        now: input.now,
      });

      if (input.businessContextHash) {
        await tx.upsertRunContextSnapshot({
          runId: input.runId,
          businessContext: input.persistBusinessContext ? input.businessContext : null,
          businessContextHash: input.businessContextHash,
          persisted: Boolean(input.persistBusinessContext),
          now: input.now,
        });
      }

      return { run, conversation, messages, profileSnapshot };
    });
  }

  async getProfileSnapshotForRun(runId: string): Promise<ProfileSnapshotRecord | null> {
    const row = await maybeOne<ProfileSnapshotRow>(
      this.client,
      'SELECT * FROM profile_snapshots WHERE run_id = $1',
      [runId],
    );
    return row ? mapProfileSnapshot(row) : null;
  }

  async upsertRunPromptSnapshot(input: UpsertRunPromptSnapshotInput): Promise<void> {
    await this.client.query(
      `
      INSERT INTO run_prompt_snapshots (
        run_id, prompt_snapshot, prompt_snapshot_hash, char_count, byte_count, persisted, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(run_id) DO UPDATE SET
        prompt_snapshot = excluded.prompt_snapshot,
        prompt_snapshot_hash = excluded.prompt_snapshot_hash,
        char_count = excluded.char_count,
        byte_count = excluded.byte_count,
        persisted = excluded.persisted
      `,
      [
        input.runId,
        input.promptSnapshot,
        input.promptSnapshotHash,
        input.charCount,
        input.byteCount,
        input.persisted ? 1 : 0,
        input.now,
      ],
    );
  }

  async updateRunPromptSnapshotFields(
    input: UpdateRunPromptSnapshotFieldsInput,
  ): Promise<RunRecord> {
    await this.client.query(
      `
      UPDATE runs
      SET prompt_snapshot_hash = $1,
          prompt_snapshot_char_count = $2,
          prompt_snapshot_byte_count = $3,
          prompt_snapshot_persisted = $4,
          updated_at = $5
      WHERE id = $6
      `,
      [
        input.promptSnapshotHash,
        input.charCount,
        input.byteCount,
        input.persisted ? 1 : 0,
        input.now,
        input.runId,
      ],
    );
    return this.getRunById(input.runId);
  }

  async upsertRunSkillSnapshot(input: UpsertRunSkillSnapshotInput): Promise<void> {
    await this.client.query(
      `
      INSERT INTO run_skill_snapshots (
        run_id, skill_id, skill_name, skill_description, skill_body_hash,
        skill_body, side_files_manifest_json, persisted, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT(run_id) DO UPDATE SET
        skill_id = excluded.skill_id,
        skill_name = excluded.skill_name,
        skill_description = excluded.skill_description,
        skill_body_hash = excluded.skill_body_hash,
        skill_body = excluded.skill_body,
        side_files_manifest_json = excluded.side_files_manifest_json,
        persisted = excluded.persisted
      `,
      [
        input.runId,
        input.skillId,
        input.skillName,
        input.skillDescription,
        input.skillBodyHash,
        input.skillBody,
        stringifyNullable(input.sideFilesManifest),
        input.persisted ? 1 : 0,
        input.now,
      ],
    );
  }

  async upsertRunContextSnapshot(input: UpsertRunContextSnapshotInput): Promise<void> {
    await this.client.query(
      `
      INSERT INTO run_context_snapshots (
        run_id, business_context_json, business_context_hash, persisted, created_at
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(run_id) DO UPDATE SET
        business_context_json = excluded.business_context_json,
        business_context_hash = excluded.business_context_hash,
        persisted = excluded.persisted
      `,
      [
        input.runId,
        input.persisted ? stringifyNullable(input.businessContext) : null,
        input.businessContextHash,
        input.persisted ? 1 : 0,
        input.now,
      ],
    );
  }

  async getRunPromptSnapshot(runId: string): Promise<RunPromptSnapshotRecord | null> {
    const row = await maybeOne<RunPromptSnapshotRow>(
      this.client,
      'SELECT * FROM run_prompt_snapshots WHERE run_id = $1',
      [runId],
    );
    return row ? mapRunPromptSnapshot(row) : null;
  }

  async getRunSkillSnapshot(runId: string): Promise<RunSkillSnapshotRecord | null> {
    const row = await maybeOne<RunSkillSnapshotRow>(
      this.client,
      'SELECT * FROM run_skill_snapshots WHERE run_id = $1',
      [runId],
    );
    return row ? mapRunSkillSnapshot(row) : null;
  }

  async getRunContextSnapshot(runId: string): Promise<RunContextSnapshotRecord | null> {
    const row = await maybeOne<RunContextSnapshotRow>(
      this.client,
      'SELECT * FROM run_context_snapshots WHERE run_id = $1',
      [runId],
    );
    return row ? mapRunContextSnapshot(row) : null;
  }

  async markInterruptedRunsOnStartup(now: number): Promise<number> {
    const result = await this.client.query(
      `
      UPDATE runs
      SET status = 'interrupted',
          finished_at = $1,
          error_code = 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
          error_message = 'Run interrupted by daemon restart',
          updated_at = $2
      WHERE status IN ('queued', 'running')
      `,
      [now, now],
    );
    return result.rowCount ?? 0;
  }

  async insertRunMessagesForRunCreate(
    input: InsertRunMessagesForRunCreateInput,
  ): Promise<RunMessageRecord[]> {
    const userConversationSeq = await this.nextConversationSeq(input.conversationId);
    const assistantConversationSeq = userConversationSeq + 1;
    await this.client.query(
      `
      INSERT INTO run_messages (
        id, workspace_id, conversation_id, run_id, role, content, thinking_content,
        run_status, position, conversation_seq, created_at, updated_at
      )
      VALUES
        ($1, $2, $3, $4, 'user', $5, '', NULL, 0, $6, $7, $8),
        ($9, $10, $11, $12, 'assistant', '', '', 'queued', 1, $13, $14, $15)
      `,
      [
        input.userMessageId,
        input.workspaceId,
        input.conversationId,
        input.runId,
        input.prompt,
        userConversationSeq,
        input.now,
        input.now,
        input.assistantMessageId,
        input.workspaceId,
        input.conversationId,
        input.runId,
        assistantConversationSeq,
        input.now,
        input.now,
      ],
    );
    return this.getRunMessages(input.runId);
  }

  async insertAssistantRunMessage(input: InsertAssistantRunMessageInput): Promise<RunMessageRecord> {
    const conversationSeq = await this.nextConversationSeq(input.conversationId);
    await this.client.query(
      `
      INSERT INTO run_messages (
        id, workspace_id, conversation_id, run_id, role, content, thinking_content,
        events_json, attachments_json, produced_files_json,
        run_status, last_run_event_id, started_at, ended_at, position, conversation_seq,
        created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, 'assistant', $5, $6,
        $7, $8, $9,
        $10, $11, $12, $13, $14, $15,
        $16, $17
      )
      `,
      [
        input.id,
        input.workspaceId,
        input.conversationId,
        input.runId,
        input.content ?? '',
        input.thinkingContent ?? '',
        stringifyNullable(input.events),
        stringifyNullable(input.attachments),
        stringifyNullable(input.producedFiles),
        input.runStatus,
        input.lastRunEventId ?? null,
        input.startedAt ?? null,
        input.endedAt ?? null,
        input.position,
        conversationSeq,
        input.now,
        input.now,
      ],
    );
    return this.getRunMessageById(input.id);
  }

  async updateAssistantMessagesTerminalForRun(
    input: UpdateAssistantMessagesTerminalForRunInput,
  ): Promise<number> {
    const result = await this.client.query(
      `
      UPDATE run_messages
      SET run_status = $1,
          ended_at = $2,
          last_run_event_id = COALESCE($3, last_run_event_id),
          updated_at = $4
      WHERE run_id = $5
        AND role = 'assistant'
      `,
      [input.runStatus, input.endedAt, input.lastRunEventId ?? null, input.now, input.runId],
    );
    return result.rowCount ?? 0;
  }

  async updateRunStarted(input: UpdateRunStartedInput): Promise<RunRecord> {
    await this.client.query(
      `
      UPDATE runs
      SET status = 'running',
          started_at = $1,
          last_run_event_id = COALESCE($2, last_run_event_id),
          updated_at = $3
      WHERE id = $4
      `,
      [input.startedAt, input.lastRunEventId ?? null, input.now, input.runId],
    );
    return this.getRunById(input.runId);
  }

  async updateRunTerminal(input: UpdateRunTerminalInput): Promise<RunRecord> {
    const existing = await this.getRunById(input.runId);
    await this.client.query(
      `
      UPDATE runs
      SET status = $1,
          finished_at = $2,
          exit_code = $3,
          signal = $4,
          error_code = $5,
          error_message = $6,
          usage_json = $7,
          last_run_event_id = $8,
          updated_at = $9
      WHERE id = $10
      `,
      [
        input.status,
        input.finishedAt,
        input.exitCode === undefined ? existing.exitCode : input.exitCode,
        input.signal === undefined ? existing.signal : input.signal,
        input.errorCode === undefined ? existing.errorCode : input.errorCode,
        input.errorMessage === undefined ? existing.errorMessage : input.errorMessage,
        input.usage === undefined ? stringifyNullable(existing.usage) : stringifyNullable(input.usage),
        input.lastRunEventId === undefined ? existing.lastRunEventId : input.lastRunEventId,
        input.now,
        input.runId,
      ],
    );
    return this.getRunById(input.runId);
  }

  async updateAssistantMessageStarted(
    input: UpdateAssistantMessageStartedInput,
  ): Promise<RunMessageRecord> {
    return this.updateRunMessage({
      messageId: input.messageId,
      runStatus: 'running',
      lastRunEventId: input.lastRunEventId,
      startedAt: input.startedAt,
      now: input.now,
    });
  }

  async updateAssistantMessageTerminal(
    input: UpdateAssistantMessageTerminalInput,
  ): Promise<RunMessageRecord> {
    return this.updateRunMessage({
      messageId: input.messageId,
      runStatus: input.runStatus,
      content: input.content,
      thinkingContent: input.thinkingContent,
      events: input.events,
      attachments: input.attachments,
      producedFiles: input.producedFiles,
      lastRunEventId: input.lastRunEventId,
      endedAt: input.endedAt,
      now: input.now,
    });
  }

  async updateRunMessage(input: UpdateRunMessageInput): Promise<RunMessageRecord> {
    const existing = await this.getRunMessageById(input.messageId);
    await this.client.query(
      `
      UPDATE run_messages
      SET content = $1,
          thinking_content = $2,
          events_json = $3,
          attachments_json = $4,
          produced_files_json = $5,
          run_status = $6,
          last_run_event_id = $7,
          started_at = $8,
          ended_at = $9,
          updated_at = $10
      WHERE id = $11
      `,
      [
        input.content ?? existing.content,
        input.thinkingContent ?? existing.thinkingContent,
        input.events === undefined ? stringifyNullable(existing.events) : stringifyNullable(input.events),
        input.attachments === undefined
          ? stringifyNullable(existing.attachments)
          : stringifyNullable(input.attachments),
        input.producedFiles === undefined
          ? stringifyNullable(existing.producedFiles)
          : stringifyNullable(input.producedFiles),
        input.runStatus ?? existing.runStatus,
        input.lastRunEventId === undefined ? existing.lastRunEventId : input.lastRunEventId,
        input.startedAt ?? existing.startedAt,
        input.endedAt ?? existing.endedAt,
        input.now,
        input.messageId,
      ],
    );
    return this.getRunMessageById(input.messageId);
  }

  async replaceArtifactsForRun(input: ReplaceArtifactsForRunInput): Promise<ArtifactRecord[]> {
    return this.transaction(async (tx) => {
      const pgTx = tx as PostgresRunnerPersistence;
      await pgTx.client.query('DELETE FROM artifacts WHERE run_id = $1', [input.runId]);

      for (const artifact of input.artifacts) {
        await pgTx.client.query(
          `
          INSERT INTO artifacts (
            id, run_id, workspace_id, rule_id, role, relative_path, file_name,
            mime_type, size, mtime, sha256, metadata_json, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          `,
          [
            artifact.id,
            input.runId,
            input.workspaceId,
            artifact.ruleId,
            artifact.role,
            artifact.relativePath,
            artifact.fileName,
            artifact.mimeType ?? null,
            artifact.size ?? null,
            artifact.mtime ?? null,
            artifact.sha256 ?? null,
            stringifyNullable(artifact.metadata),
            input.now,
          ],
        );
      }

      return tx.listArtifactsForRun({ runId: input.runId, clientId: '', isAdmin: true });
    });
  }

  async listArtifactsForRun(input: ListArtifactsForRunInput): Promise<ArtifactRecord[]> {
    const result = input.isAdmin
      ? await this.client.query<ArtifactRow>(
          `
          SELECT artifacts.*
          FROM artifacts
          JOIN runs ON runs.id = artifacts.run_id
          WHERE artifacts.run_id = $1
          ORDER BY
            CASE artifacts.role
              WHEN 'primary' THEN 0
              WHEN 'supporting' THEN 1
              WHEN 'debug' THEN 2
              ELSE 3
            END,
            artifacts.relative_path ASC
          `,
          [input.runId],
        )
      : await this.client.query<ArtifactRow>(
          `
          SELECT artifacts.*
          FROM artifacts
          JOIN runs ON runs.id = artifacts.run_id
          WHERE artifacts.run_id = $1 AND runs.client_id = $2
          ORDER BY
            CASE artifacts.role
              WHEN 'primary' THEN 0
              WHEN 'supporting' THEN 1
              WHEN 'debug' THEN 2
              ELSE 3
            END,
            artifacts.relative_path ASC
          `,
          [input.runId, input.clientId],
        );
    return result.rows.map(mapArtifact);
  }

  async getArtifactForRunForClient(
    input: GetArtifactForRunForClientInput,
  ): Promise<ArtifactRecord | null> {
    const row = input.isAdmin
      ? await maybeOne<ArtifactRow>(
          this.client,
          `
          SELECT artifacts.*
          FROM artifacts
          JOIN runs ON runs.id = artifacts.run_id
          WHERE artifacts.run_id = $1 AND artifacts.id = $2
          `,
          [input.runId, input.artifactId],
        )
      : await maybeOne<ArtifactRow>(
          this.client,
          `
          SELECT artifacts.*
          FROM artifacts
          JOIN runs ON runs.id = artifacts.run_id
          WHERE artifacts.run_id = $1 AND artifacts.id = $2 AND runs.client_id = $3
          `,
          [input.runId, input.artifactId, input.clientId],
        );
    return row ? mapArtifact(row) : null;
  }

  async upsertRunLogPaths(input: UpsertRunLogPathsInput): Promise<RunLogRecord> {
    assertRelativeLogPath(input.stdoutLogPath);
    assertRelativeLogPath(input.stderrLogPath);
    assertRelativeLogPath(input.debugEventsLogPath);

    await this.client.query(
      `
      INSERT INTO run_logs (
        run_id, stdout_log_path, stderr_log_path, debug_events_log_path, created_at
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(run_id) DO UPDATE SET
        stdout_log_path = excluded.stdout_log_path,
        stderr_log_path = excluded.stderr_log_path,
        debug_events_log_path = excluded.debug_events_log_path
      `,
      [
        input.runId,
        input.stdoutLogPath,
        input.stderrLogPath,
        input.debugEventsLogPath,
        input.now,
      ],
    );
    return this.getRunLogByRunId(input.runId);
  }

  async getRunLogForRunForClient(
    input: GetRunLogForRunForClientInput,
  ): Promise<RunLogRecord | null> {
    const row = input.isAdmin
      ? await maybeOne<RunLogRow>(this.client, 'SELECT * FROM run_logs WHERE run_id = $1', [
          input.runId,
        ])
      : await maybeOne<RunLogRow>(
          this.client,
          `
          SELECT run_logs.*
          FROM run_logs
          JOIN runs ON runs.id = run_logs.run_id
          WHERE run_logs.run_id = $1 AND runs.client_id = $2
          `,
          [input.runId, input.clientId],
        );
    return row ? mapRunLog(row) : null;
  }

  async listRunLogsFinishedBefore(input: ListRunLogsFinishedBeforeInput): Promise<RunLogRecord[]> {
    const result = await this.client.query<RunLogRow>(
      `
      SELECT run_logs.*
      FROM run_logs
      JOIN runs ON runs.id = run_logs.run_id
      WHERE runs.finished_at IS NOT NULL
        AND runs.finished_at < $1
        AND runs.status IN ('succeeded', 'failed', 'canceled', 'interrupted')
      ORDER BY runs.finished_at ASC, run_logs.created_at ASC
      LIMIT $2
      `,
      [input.finishedBefore, input.limit],
    );
    return result.rows.map(mapRunLog);
  }

  async deleteRunLogRows(runIds: readonly string[]): Promise<number> {
    if (runIds.length === 0) return 0;
    return this.transaction(async (tx) => {
      let changes = 0;
      const pgTx = tx as PostgresRunnerPersistence;
      for (const runId of runIds) {
        const result = await pgTx.client.query('DELETE FROM run_logs WHERE run_id = $1', [runId]);
        changes += result.rowCount ?? 0;
      }
      return changes;
    });
  }

  async insertRunFeedback(input: InsertRunFeedbackInput): Promise<RunFeedbackRecord> {
    await this.client.query(
      `
      INSERT INTO run_feedback (
        id, run_id, client_id, category, message, metadata_json, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        input.id,
        input.runId,
        input.clientId,
        input.category,
        input.message,
        stringifyNullable(input.metadata),
        input.now,
      ],
    );
    return this.getRunFeedbackById(input.id);
  }

  async listRunFeedbackForClient(
    input: ListRunFeedbackForClientInput,
  ): Promise<RunFeedbackRecord[] | null> {
    const run = await this.getRunForClient(input);
    if (!run) {
      return null;
    }
    const result = await this.client.query<RunFeedbackRow>(
      `
      SELECT *
      FROM run_feedback
      WHERE run_id = $1
      ORDER BY created_at ASC, id ASC
      `,
      [input.runId],
    );
    return result.rows.map(mapRunFeedback);
  }

  async getRunDetail(input: RunForClientInput): Promise<RunDetailRecord | null> {
    const run = await this.getRunForClient(input);
    if (!run) {
      return null;
    }
    return { run, messages: await this.getRunMessages(input.runId) };
  }

  async getRunForClient(input: RunForClientInput): Promise<RunRecord | null> {
    const row = input.isAdmin
      ? await maybeOne<RunRow>(this.client, 'SELECT * FROM runs WHERE id = $1', [input.runId])
      : await maybeOne<RunRow>(
          this.client,
          'SELECT * FROM runs WHERE id = $1 AND client_id = $2',
          [input.runId, input.clientId],
        );
    return row ? mapRun(row) : null;
  }

  async getRunWithWorkspaceForClient(input: RunForClientInput): Promise<RunWithWorkspaceRecord | null> {
    const run = await this.getRunForClient(input);
    if (!run) {
      return null;
    }
    return { run, workspace: await this.getWorkspaceById(run.workspaceId) };
  }

  async listRunsForClient(input: ListRunsForClientInput): Promise<RunRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    addClause(clauses, params, !input.isAdmin, 'runs.client_id', input.clientId);
    addClause(clauses, params, Boolean(input.status), 'runs.status', input.status);
    addClause(clauses, params, Boolean(input.workspaceId), 'runs.workspace_id', input.workspaceId);

    const extra = input as ListRunsForClientInput & {
      originId?: string;
      userId?: string;
      projectId?: string;
      workspaceKey?: string;
      workspacePrefix?: string;
    };
    addClause(clauses, params, Boolean(extra.originId), 'workspaces.origin_id', extra.originId);
    addClause(clauses, params, Boolean(extra.userId), 'workspaces.user_id', extra.userId);
    addClause(clauses, params, Boolean(extra.projectId), 'workspaces.project_id', extra.projectId);
    addClause(clauses, params, Boolean(extra.workspaceKey), 'workspaces.workspace_key', extra.workspaceKey);
    if (extra.workspacePrefix) {
      params.push(`${extra.workspacePrefix}%`);
      clauses.push(`workspaces.workspace_key LIKE $${params.length}`);
    }

    const limit = input.limit ?? 100;
    params.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.client.query<RunRow>(
      `
      SELECT runs.*
      FROM runs
      JOIN workspaces ON workspaces.id = runs.workspace_id
      ${where}
      ORDER BY runs.created_at DESC
      LIMIT $${params.length}
      `,
      params,
    );
    return result.rows.map(mapRun);
  }

  async getRunByIdempotencyKey(
    input: GetRunByIdempotencyKeyInput,
  ): Promise<RunRecord | null> {
    const row = await maybeOne<RunRow>(
      this.client,
      `
      SELECT *
      FROM runs
      WHERE client_id = $1
        AND profile_id = $2
        AND workspace_id = $3
        AND idempotency_key = $4
      `,
      [input.clientId, input.profileId, input.workspaceId, input.idempotencyKey],
    );
    return row ? mapRun(row) : null;
  }

  private async getWorkspaceById(workspaceId: string): Promise<WorkspaceRecord> {
    const row = await maybeOne<WorkspaceRow>(this.client, 'SELECT * FROM workspaces WHERE id = $1', [
      workspaceId,
    ]);
    if (!row) {
      throw new Error(`Workspace not found after write: ${workspaceId}`);
    }
    return mapWorkspace(row);
  }

  private async getConversationById(conversationId: string): Promise<ConversationRecord> {
    const row = await maybeOne<ConversationRow>(
      this.client,
      'SELECT * FROM conversations WHERE id = $1',
      [conversationId],
    );
    if (!row) {
      throw new Error(`Conversation not found after write: ${conversationId}`);
    }
    return mapConversation(row);
  }

  private async getRunById(runId: string): Promise<RunRecord> {
    const row = await maybeOne<RunRow>(this.client, 'SELECT * FROM runs WHERE id = $1', [runId]);
    if (!row) {
      throw new Error(`Run not found after write: ${runId}`);
    }
    return mapRun(row);
  }

  private async getRunMessageById(messageId: string): Promise<RunMessageRecord> {
    const row = await maybeOne<RunMessageRow>(
      this.client,
      'SELECT * FROM run_messages WHERE id = $1',
      [messageId],
    );
    if (!row) {
      throw new Error(`Run message not found after write: ${messageId}`);
    }
    return mapRunMessage(row);
  }

  private async getRunMessages(runId: string): Promise<RunMessageRecord[]> {
    const result = await this.client.query<RunMessageRow>(
      'SELECT * FROM run_messages WHERE run_id = $1 ORDER BY position ASC',
      [runId],
    );
    return result.rows.map(mapRunMessage);
  }

  private async getRunLogByRunId(runId: string): Promise<RunLogRecord> {
    const row = await maybeOne<RunLogRow>(this.client, 'SELECT * FROM run_logs WHERE run_id = $1', [
      runId,
    ]);
    if (!row) {
      throw new Error(`Run log not found after write: ${runId}`);
    }
    return mapRunLog(row);
  }

  private async getRunFeedbackById(feedbackId: string): Promise<RunFeedbackRecord> {
    const row = await maybeOne<RunFeedbackRow>(
      this.client,
      'SELECT * FROM run_feedback WHERE id = $1',
      [feedbackId],
    );
    if (!row) {
      throw new Error(`Run feedback not found after write: ${feedbackId}`);
    }
    return mapRunFeedback(row);
  }

  private async nextConversationSeq(conversationId: string): Promise<number> {
    const row = await one<{ max_seq: number }>(
      this.client,
      'SELECT COALESCE(MAX(conversation_seq), 0) AS max_seq FROM run_messages WHERE conversation_id = $1',
      [conversationId],
    );
    return row.max_seq + 1;
  }

  private async insertProfileSnapshot(
    persistence: RunnerPersistence,
    input: { runId: string; profile: unknown; now: number },
  ): Promise<ProfileSnapshotRecord> {
    const pgPersistence = persistence as PostgresRunnerPersistence;
    await pgPersistence.client.query(
      `
      INSERT INTO profile_snapshots (run_id, profile_json, created_at)
      VALUES ($1, $2, $3)
      `,
      [input.runId, JSON.stringify(input.profile), input.now],
    );
    const snapshot = await persistence.getProfileSnapshotForRun(input.runId);
    if (!snapshot) {
      throw new Error(`Profile snapshot not found after write: ${input.runId}`);
    }
    return snapshot;
  }
}

function isPool(client: PostgresClient): client is PostgresPool {
  return !('release' in client);
}

async function maybeOne<T extends pg.QueryResultRow>(
  client: Queryable,
  text: string,
  values: readonly unknown[],
): Promise<T | null> {
  const result = await client.query<T>(text, [...values]);
  return result.rows[0] ?? null;
}

async function one<T extends pg.QueryResultRow>(
  client: Queryable,
  text: string,
  values: readonly unknown[],
): Promise<T> {
  const row = await maybeOne<T>(client, text, values);
  if (!row) {
    throw new Error('Expected PostgreSQL query to return a row');
  }
  return row;
}

function addClause(
  clauses: string[],
  params: unknown[],
  enabled: boolean,
  column: string,
  value: unknown,
): void {
  if (!enabled) return;
  params.push(value);
  clauses.push(`${column} = $${params.length}`);
}

function advisoryLockKeys(value: string): [number, number] {
  const digest = crypto.createHash('sha256').update(value).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    clientId: row.client_id,
    originId: row.origin_id,
    userId: row.user_id,
    projectId: row.project_id,
    workspaceKey: row.workspace_key,
    status: row.status,
    metadata: parseNullable(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    clientId: row.client_id,
    kind: row.kind,
    skillId: row.skill_id,
    status: row.status,
    prompt: row.prompt,
    promptMode: row.prompt_mode,
    currentPrompt: row.current_prompt,
    contextPolicy: parseNullable(row.context_policy_json) as ContextPolicy | null,
    collectionMode: row.collection_mode,
    promptSnapshotHash: row.prompt_snapshot_hash,
    promptSnapshotCharCount: row.prompt_snapshot_char_count,
    promptSnapshotByteCount: row.prompt_snapshot_byte_count,
    promptSnapshotPersisted: row.prompt_snapshot_persisted === 1,
    businessContextHash: row.business_context_hash,
    artifactRuleIds: parseNullable(row.artifact_rule_ids_json) as string[] | null,
    idempotencyKey: row.idempotency_key,
    idempotencyFingerprint: row.idempotency_fingerprint,
    lastRunEventId: row.last_run_event_id,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    signal: row.signal,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    usage: parseNullable(row.usage_json),
    metadata: parseNullable(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRunMessage(row: RunMessageRow): RunMessageRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    role: row.role,
    content: row.content,
    thinkingContent: row.thinking_content,
    events: parseNullable(row.events_json),
    attachments: parseNullable(row.attachments_json),
    producedFiles: parseNullable(row.produced_files_json),
    runStatus: row.run_status,
    lastRunEventId: row.last_run_event_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    position: row.position,
    conversationSeq: row.conversation_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProfileSnapshot(row: ProfileSnapshotRow): ProfileSnapshotRecord {
  return {
    runId: row.run_id,
    profile: JSON.parse(row.profile_json) as unknown,
    createdAt: row.created_at,
  };
}

function mapRunPromptSnapshot(row: RunPromptSnapshotRow): RunPromptSnapshotRecord {
  return {
    runId: row.run_id,
    promptSnapshot: row.prompt_snapshot,
    promptSnapshotHash: row.prompt_snapshot_hash,
    charCount: row.char_count,
    byteCount: row.byte_count,
    persisted: row.persisted === 1,
    createdAt: row.created_at,
  };
}

function mapRunSkillSnapshot(row: RunSkillSnapshotRow): RunSkillSnapshotRecord {
  return {
    runId: row.run_id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    skillDescription: row.skill_description,
    skillBodyHash: row.skill_body_hash,
    skillBody: row.skill_body,
    sideFilesManifest: parseNullable(row.side_files_manifest_json),
    persisted: row.persisted === 1,
    createdAt: row.created_at,
  };
}

function mapRunContextSnapshot(row: RunContextSnapshotRow): RunContextSnapshotRecord {
  return {
    runId: row.run_id,
    businessContext: parseNullable(row.business_context_json),
    businessContextHash: row.business_context_hash,
    persisted: row.persisted === 1,
    createdAt: row.created_at,
  };
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    ruleId: row.rule_id,
    role: row.role as ArtifactRole,
    relativePath: row.relative_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: row.size,
    mtime: row.mtime,
    sha256: row.sha256,
    metadata: parseNullable(row.metadata_json),
    createdAt: row.created_at,
  };
}

function mapRunLog(row: RunLogRow): RunLogRecord {
  return {
    runId: row.run_id,
    stdoutLogPath: row.stdout_log_path,
    stderrLogPath: row.stderr_log_path,
    debugEventsLogPath: row.debug_events_log_path,
    createdAt: row.created_at,
  };
}

function mapRunFeedback(row: RunFeedbackRow): RunFeedbackRecord {
  return {
    id: row.id,
    runId: row.run_id,
    clientId: row.client_id,
    category: row.category,
    message: row.message,
    metadata: parseNullable(row.metadata_json),
    createdAt: row.created_at,
  };
}

function stringifyNullable(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseNullable(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function assertRelativeLogPath(value: string | null): void {
  if (value !== null && path.isAbsolute(value)) {
    throw new Error('Run log paths must be relative to dataDir');
  }
}

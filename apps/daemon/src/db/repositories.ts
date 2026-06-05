import path from 'node:path';
import type {
  ArtifactRole,
  CollectionMode,
  PromptMode,
  RunKind,
  RunStatus,
} from '../core/run-types.js';
import type { RunnerDatabase } from './connection.js';

export interface WorkspaceRecord {
  id: string;
  profileId: string;
  clientId: string;
  originId: string;
  userId: string;
  projectId: string;
  workspaceKey: string;
  status: string;
  metadata: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  profileId: string;
  clientId: string;
  kind: RunKind;
  skillId: string | null;
  status: RunStatus;
  prompt: string;
  promptMode: PromptMode;
  currentPrompt: string | null;
  collectionMode: CollectionMode;
  promptSnapshotHash: string | null;
  promptSnapshotCharCount: number | null;
  promptSnapshotByteCount: number | null;
  promptSnapshotPersisted: boolean;
  businessContextHash: string | null;
  artifactRuleIds: string[] | null;
  lastRunEventId: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  usage: unknown;
  metadata: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface RunMessageRecord {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  runId: string;
  role: string;
  content: string;
  thinkingContent: string;
  events: unknown;
  attachments: unknown;
  producedFiles: unknown;
  runStatus: string | null;
  lastRunEventId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  workspaceId: string;
  ruleId: string;
  role: ArtifactRole;
  relativePath: string;
  fileName: string;
  mimeType: string | null;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
  metadata: unknown;
  createdAt: number;
}

export interface RunDetailRecord {
  run: RunRecord;
  messages: RunMessageRecord[];
}

export interface RunWithWorkspaceRecord {
  run: RunRecord;
  workspace: WorkspaceRecord;
}

export interface RunLogRecord {
  runId: string;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  debugEventsLogPath: string | null;
  createdAt: number;
}

export interface ProfileSnapshotRecord {
  runId: string;
  profile: unknown;
  createdAt: number;
}

export interface RunPromptSnapshotRecord {
  runId: string;
  promptSnapshot: string | null;
  promptSnapshotHash: string | null;
  charCount: number | null;
  byteCount: number | null;
  persisted: boolean;
  createdAt: number;
}

export interface RunSkillSnapshotRecord {
  runId: string;
  skillId: string | null;
  skillName: string | null;
  skillDescription: string | null;
  skillBodyHash: string | null;
  skillBody: string | null;
  sideFilesManifest: unknown;
  persisted: boolean;
  createdAt: number;
}

export interface RunContextSnapshotRecord {
  runId: string;
  businessContext: unknown;
  businessContextHash: string | null;
  persisted: boolean;
  createdAt: number;
}

export interface CreateRunQueuedWithMessagesAndSnapshotResult {
  run: RunRecord;
  conversation: ConversationRecord;
  messages: RunMessageRecord[];
  profileSnapshot: ProfileSnapshotRecord;
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
  collection_mode: CollectionMode;
  prompt_snapshot_hash: string | null;
  prompt_snapshot_char_count: number | null;
  prompt_snapshot_byte_count: number | null;
  prompt_snapshot_persisted: number;
  business_context_hash: string | null;
  artifact_rule_ids_json: string | null;
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

export function makeWorkspaceKey(originId: string, userId: string, projectId: string): string {
  return `${originId}/${userId}/${projectId}`;
}

export function upsertWorkspace(
  db: RunnerDatabase,
  input: {
    id: string;
    profileId: string;
    clientId: string;
    originId: string;
    userId: string;
    projectId: string;
    status?: string;
    metadata?: unknown;
    now: number;
  },
): WorkspaceRecord {
  const workspaceKey = makeWorkspaceKey(input.originId, input.userId, input.projectId);
  const existing = db
    .prepare('SELECT * FROM workspaces WHERE client_id = ? AND profile_id = ? AND workspace_key = ?')
    .get(input.clientId, input.profileId, workspaceKey) as WorkspaceRow | undefined;

  if (existing) {
    const nextMetadataJson =
      input.metadata === undefined ? existing.metadata_json : stringifyNullable(input.metadata);
    db.prepare(
      `
      UPDATE workspaces
      SET status = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
      `,
    ).run(input.status ?? existing.status, nextMetadataJson, input.now, existing.id);
    return getWorkspaceById(db, existing.id);
  }

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
    input.status ?? 'active',
    stringifyNullable(input.metadata),
    input.now,
    input.now,
  );

  return getWorkspaceById(db, input.id);
}

export function getWorkspaceForClient(
  db: RunnerDatabase,
  input: { workspaceId: string; clientId: string; isAdmin?: boolean },
): WorkspaceRecord | null {
  const row = input.isAdmin
    ? (db.prepare('SELECT * FROM workspaces WHERE id = ?').get(input.workspaceId) as
        | WorkspaceRow
        | undefined)
    : (db
        .prepare('SELECT * FROM workspaces WHERE id = ? AND client_id = ?')
        .get(input.workspaceId, input.clientId) as WorkspaceRow | undefined);
  return row ? mapWorkspace(row) : null;
}

export function getOrCreateDefaultConversation(
  db: RunnerDatabase,
  input: { id: string; workspaceId: string; now: number },
): ConversationRecord {
  const existing = db
    .prepare('SELECT * FROM conversations WHERE workspace_id = ? AND title = ? ORDER BY created_at LIMIT 1')
    .get(input.workspaceId, 'Default') as ConversationRow | undefined;

  if (existing) {
    return mapConversation(existing);
  }

  db.prepare(
    `
    INSERT INTO conversations (id, workspace_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    `,
  ).run(input.id, input.workspaceId, 'Default', input.now, input.now);

  return mapConversation(
    db.prepare('SELECT * FROM conversations WHERE id = ?').get(input.id) as ConversationRow,
  );
}

export function getConversationForWorkspace(
  db: RunnerDatabase,
  input: { conversationId: string; workspaceId: string },
): ConversationRecord | null {
  const row = db
    .prepare('SELECT * FROM conversations WHERE id = ? AND workspace_id = ?')
    .get(input.conversationId, input.workspaceId) as ConversationRow | undefined;
  return row ? mapConversation(row) : null;
}

export function insertRunQueued(
  db: RunnerDatabase,
  input: {
    id: string;
    workspaceId: string;
    profileId: string;
    clientId: string;
    kind: RunKind;
    skillId?: string;
    prompt: string;
    promptMode?: PromptMode;
    currentPrompt?: string | null;
    collectionMode?: CollectionMode;
    promptSnapshotHash?: string | null;
    promptSnapshotCharCount?: number | null;
    promptSnapshotByteCount?: number | null;
    promptSnapshotPersisted?: boolean;
    businessContextHash?: string | null;
    artifactRuleIds?: string[];
    metadata?: unknown;
    now: number;
  },
): RunRecord {
  db.prepare(
    `
    INSERT INTO runs (
      id, workspace_id, profile_id, client_id, kind, skill_id, status, prompt,
      prompt_mode, current_prompt, collection_mode, prompt_snapshot_hash,
      prompt_snapshot_char_count, prompt_snapshot_byte_count, prompt_snapshot_persisted,
      business_context_hash, artifact_rule_ids_json, queued_at, metadata_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
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
    input.collectionMode ?? 'lite',
    input.promptSnapshotHash ?? null,
    input.promptSnapshotCharCount ?? null,
    input.promptSnapshotByteCount ?? null,
    input.promptSnapshotPersisted ? 1 : 0,
    input.businessContextHash ?? null,
    stringifyNullable(input.artifactRuleIds),
    input.now,
    stringifyNullable(input.metadata),
    input.now,
    input.now,
  );

  return getRunById(db, input.id);
}

export function createRunQueuedWithMessagesAndSnapshot(
  db: RunnerDatabase,
  input: {
    runId: string;
    conversationId?: string;
    defaultConversationId?: string;
    userMessageId: string;
    assistantMessageId: string;
    workspaceId: string;
    profileId: string;
    clientId: string;
    kind: RunKind;
    skillId?: string;
    prompt: string;
    promptMode?: PromptMode;
    currentPrompt?: string | null;
    collectionMode?: CollectionMode;
    businessContext?: unknown;
    businessContextHash?: string | null;
    persistBusinessContext?: boolean;
    artifactRuleIds?: string[];
    metadata?: unknown;
    profileSnapshot: unknown;
    now: number;
  },
): CreateRunQueuedWithMessagesAndSnapshotResult {
  const create = db.transaction((): CreateRunQueuedWithMessagesAndSnapshotResult => {
    const conversation =
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

    if (!conversation) {
      throw new Error('Repository caller must validate conversation ownership before insert');
    }

    const run = insertRunQueued(db, {
      id: input.runId,
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      clientId: input.clientId,
      kind: input.kind,
      skillId: input.skillId,
      prompt: input.prompt,
      promptMode: input.promptMode,
      currentPrompt: input.currentPrompt,
      collectionMode: input.collectionMode,
      businessContextHash: input.businessContextHash,
      artifactRuleIds: input.artifactRuleIds,
      metadata: input.metadata,
      now: input.now,
    });
    const messages = insertRunMessagesForRunCreate(db, {
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
      runId: input.runId,
      prompt: input.currentPrompt ?? input.prompt,
      now: input.now,
    });
    const profileSnapshot = insertProfileSnapshot(db, {
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

    return { run, conversation, messages, profileSnapshot };
  });

  return create();
}

export function getProfileSnapshotForRun(
  db: RunnerDatabase,
  runId: string,
): ProfileSnapshotRecord | null {
  const row = db.prepare('SELECT * FROM profile_snapshots WHERE run_id = ?').get(runId) as
    | ProfileSnapshotRow
    | undefined;
  return row ? mapProfileSnapshot(row) : null;
}

export function upsertRunPromptSnapshot(
  db: RunnerDatabase,
  input: {
    runId: string;
    promptSnapshot: string | null;
    promptSnapshotHash: string;
    charCount: number;
    byteCount: number;
    persisted: boolean;
    now: number;
  },
): void {
  db.prepare(
    `
    INSERT INTO run_prompt_snapshots (
      run_id, prompt_snapshot, prompt_snapshot_hash, char_count, byte_count, persisted, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      prompt_snapshot = excluded.prompt_snapshot,
      prompt_snapshot_hash = excluded.prompt_snapshot_hash,
      char_count = excluded.char_count,
      byte_count = excluded.byte_count,
      persisted = excluded.persisted
    `,
  ).run(
    input.runId,
    input.promptSnapshot,
    input.promptSnapshotHash,
    input.charCount,
    input.byteCount,
    input.persisted ? 1 : 0,
    input.now,
  );
}

export function updateRunPromptSnapshotFields(
  db: RunnerDatabase,
  input: {
    runId: string;
    promptSnapshotHash: string;
    charCount: number;
    byteCount: number;
    persisted: boolean;
    now: number;
  },
): RunRecord {
  db.prepare(
    `
    UPDATE runs
    SET prompt_snapshot_hash = ?,
        prompt_snapshot_char_count = ?,
        prompt_snapshot_byte_count = ?,
        prompt_snapshot_persisted = ?,
        updated_at = ?
    WHERE id = ?
    `,
  ).run(
    input.promptSnapshotHash,
    input.charCount,
    input.byteCount,
    input.persisted ? 1 : 0,
    input.now,
    input.runId,
  );

  return getRunById(db, input.runId);
}

export function upsertRunSkillSnapshot(
  db: RunnerDatabase,
  input: {
    runId: string;
    skillId: string | null;
    skillName: string | null;
    skillDescription: string | null;
    skillBodyHash: string | null;
    skillBody: string | null;
    sideFilesManifest: unknown;
    persisted: boolean;
    now: number;
  },
): void {
  db.prepare(
    `
    INSERT INTO run_skill_snapshots (
      run_id, skill_id, skill_name, skill_description, skill_body_hash,
      skill_body, side_files_manifest_json, persisted, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      skill_id = excluded.skill_id,
      skill_name = excluded.skill_name,
      skill_description = excluded.skill_description,
      skill_body_hash = excluded.skill_body_hash,
      skill_body = excluded.skill_body,
      side_files_manifest_json = excluded.side_files_manifest_json,
      persisted = excluded.persisted
    `,
  ).run(
    input.runId,
    input.skillId,
    input.skillName,
    input.skillDescription,
    input.skillBodyHash,
    input.skillBody,
    stringifyNullable(input.sideFilesManifest),
    input.persisted ? 1 : 0,
    input.now,
  );
}

export function upsertRunContextSnapshot(
  db: RunnerDatabase,
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
    input.persisted ? stringifyNullable(input.businessContext) : null,
    input.businessContextHash,
    input.persisted ? 1 : 0,
    input.now,
  );
}

export function getRunPromptSnapshot(
  db: RunnerDatabase,
  runId: string,
): RunPromptSnapshotRecord | null {
  const row = db
    .prepare('SELECT * FROM run_prompt_snapshots WHERE run_id = ?')
    .get(runId) as RunPromptSnapshotRow | undefined;
  return row ? mapRunPromptSnapshot(row) : null;
}

export function getRunSkillSnapshot(
  db: RunnerDatabase,
  runId: string,
): RunSkillSnapshotRecord | null {
  const row = db
    .prepare('SELECT * FROM run_skill_snapshots WHERE run_id = ?')
    .get(runId) as RunSkillSnapshotRow | undefined;
  return row ? mapRunSkillSnapshot(row) : null;
}

export function getRunContextSnapshot(
  db: RunnerDatabase,
  runId: string,
): RunContextSnapshotRecord | null {
  const row = db
    .prepare('SELECT * FROM run_context_snapshots WHERE run_id = ?')
    .get(runId) as RunContextSnapshotRow | undefined;
  return row ? mapRunContextSnapshot(row) : null;
}

export function markInterruptedRunsOnStartup(db: RunnerDatabase, now: number): number {
  const result = db
    .prepare(
      `
      UPDATE runs
      SET status = 'interrupted',
          finished_at = ?,
          error_code = 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
          error_message = 'Run interrupted by daemon restart',
          updated_at = ?
      WHERE status IN ('queued', 'running')
      `,
    )
    .run(now, now);
  return result.changes;
}

export function insertRunMessagesForRunCreate(
  db: RunnerDatabase,
  input: {
    userMessageId: string;
    assistantMessageId: string;
    workspaceId: string;
    conversationId: string;
    runId: string;
    prompt: string;
    now: number;
  },
): RunMessageRecord[] {
  const insert = db.prepare(
    `
    INSERT INTO run_messages (
      id, workspace_id, conversation_id, run_id, role, content, thinking_content,
      run_status, position, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.now,
    input.now,
  );

  return getRunMessages(db, input.runId);
}

export function insertAssistantRunMessage(
  db: RunnerDatabase,
  input: {
    id: string;
    workspaceId: string;
    conversationId: string;
    runId: string;
    position: number;
    runStatus: RunStatus;
    startedAt?: number | null;
    now: number;
  },
): RunMessageRecord {
  db.prepare(
    `
    INSERT INTO run_messages (
      id, workspace_id, conversation_id, run_id, role, content, thinking_content,
      run_status, started_at, position, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 'assistant', '', '', ?, ?, ?, ?, ?)
    `,
  ).run(
    input.id,
    input.workspaceId,
    input.conversationId,
    input.runId,
    input.runStatus,
    input.startedAt ?? null,
    input.position,
    input.now,
    input.now,
  );

  return getRunMessageById(db, input.id);
}

export function updateAssistantMessagesTerminalForRun(
  db: RunnerDatabase,
  input: {
    runId: string;
    runStatus: RunStatus;
    endedAt: number;
    now: number;
  },
): number {
  const result = db
    .prepare(
      `
      UPDATE run_messages
      SET run_status = ?,
          ended_at = ?,
          updated_at = ?
      WHERE run_id = ?
        AND role = 'assistant'
      `,
    )
    .run(input.runStatus, input.endedAt, input.now, input.runId);

  return result.changes;
}

export function updateRunStatus(
  db: RunnerDatabase,
  input: {
    runId: string;
    status: RunStatus;
    startedAt?: number;
    finishedAt?: number;
    exitCode?: number | null;
    signal?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    usage?: unknown;
    lastRunEventId?: string | null;
    now: number;
  },
): RunRecord {
  db.prepare(
    `
    UPDATE runs
    SET status = ?,
        started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at),
        exit_code = COALESCE(?, exit_code),
        signal = COALESCE(?, signal),
        error_code = COALESCE(?, error_code),
        error_message = COALESCE(?, error_message),
        usage_json = COALESCE(?, usage_json),
        last_run_event_id = COALESCE(?, last_run_event_id),
        updated_at = ?
    WHERE id = ?
    `,
  ).run(
    input.status,
    input.startedAt ?? null,
    input.finishedAt ?? null,
    input.exitCode ?? null,
    input.signal ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    stringifyNullable(input.usage),
    input.lastRunEventId ?? null,
    input.now,
    input.runId,
  );

  return getRunById(db, input.runId);
}

export function updateRunStarted(
  db: RunnerDatabase,
  input: { runId: string; startedAt: number; now: number },
): RunRecord {
  db.prepare(
    `
    UPDATE runs
    SET status = 'running',
        started_at = ?,
        updated_at = ?
    WHERE id = ?
    `,
  ).run(input.startedAt, input.now, input.runId);

  return getRunById(db, input.runId);
}

export function updateRunTerminal(
  db: RunnerDatabase,
  input: {
    runId: string;
    status: RunStatus;
    finishedAt: number;
    exitCode?: number | null;
    signal?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    usage?: unknown;
    lastRunEventId?: string | null;
    now: number;
  },
): RunRecord {
  const existing = getRunById(db, input.runId);
  db.prepare(
    `
    UPDATE runs
    SET status = ?,
        finished_at = ?,
        exit_code = ?,
        signal = ?,
        error_code = ?,
        error_message = ?,
        usage_json = ?,
        last_run_event_id = ?,
        updated_at = ?
    WHERE id = ?
    `,
  ).run(
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
  );

  return getRunById(db, input.runId);
}

export function updateAssistantMessageStarted(
  db: RunnerDatabase,
  input: { messageId: string; startedAt: number; now: number },
): RunMessageRecord {
  return updateRunMessage(db, {
    messageId: input.messageId,
    runStatus: 'running',
    startedAt: input.startedAt,
    now: input.now,
  });
}

export function updateAssistantMessageTerminal(
  db: RunnerDatabase,
  input: {
    messageId: string;
    runStatus: RunStatus;
    lastRunEventId?: string | null;
    endedAt: number;
    now: number;
  },
): RunMessageRecord {
  return updateRunMessage(db, {
    messageId: input.messageId,
    runStatus: input.runStatus,
    lastRunEventId: input.lastRunEventId,
    endedAt: input.endedAt,
    now: input.now,
  });
}

export function updateRunMessage(
  db: RunnerDatabase,
  input: {
    messageId: string;
    content?: string;
    thinkingContent?: string;
    events?: unknown;
    attachments?: unknown;
    producedFiles?: unknown;
    runStatus?: string;
    lastRunEventId?: string | null;
    startedAt?: number;
    endedAt?: number;
    now: number;
  },
): RunMessageRecord {
  const existing = getRunMessageById(db, input.messageId);
  db.prepare(
    `
    UPDATE run_messages
    SET content = ?,
        thinking_content = ?,
        events_json = ?,
        attachments_json = ?,
        produced_files_json = ?,
        run_status = ?,
        last_run_event_id = ?,
        started_at = ?,
        ended_at = ?,
        updated_at = ?
    WHERE id = ?
    `,
  ).run(
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
  );

  return getRunMessageById(db, input.messageId);
}

export function replaceArtifactsForRun(
  db: RunnerDatabase,
  input: {
    runId: string;
    workspaceId: string;
    artifacts: Array<{
      id: string;
      ruleId: string;
      role: ArtifactRole;
      relativePath: string;
      fileName: string;
      mimeType?: string | null;
      size?: number | null;
      mtime?: number | null;
      sha256?: string | null;
      metadata?: unknown;
    }>;
    now: number;
  },
): ArtifactRecord[] {
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM artifacts WHERE run_id = ?').run(input.runId);

    const insert = db.prepare(
      `
      INSERT INTO artifacts (
        id, run_id, workspace_id, rule_id, role, relative_path, file_name,
        mime_type, size, mtime, sha256, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    for (const artifact of input.artifacts) {
      insert.run(
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
      );
    }
  });

  replace();
  return listArtifactsForRun(db, { runId: input.runId, clientId: '', isAdmin: true });
}

export function listArtifactsForRun(
  db: RunnerDatabase,
  input: { runId: string; clientId: string; isAdmin?: boolean },
): ArtifactRecord[] {
  const rowQuery = input.isAdmin
    ? db
        .prepare(
          `
          SELECT artifacts.*
          FROM artifacts
          JOIN runs ON runs.id = artifacts.run_id
          WHERE artifacts.run_id = ?
          ORDER BY
            CASE artifacts.role
              WHEN 'primary' THEN 0
              WHEN 'supporting' THEN 1
              WHEN 'debug' THEN 2
              ELSE 3
            END,
            artifacts.relative_path ASC
          `,
        )
        .all(input.runId)
    : db
        .prepare(
          `
          SELECT artifacts.*
          FROM artifacts
          JOIN runs ON runs.id = artifacts.run_id
          WHERE artifacts.run_id = ? AND runs.client_id = ?
          ORDER BY
            CASE artifacts.role
              WHEN 'primary' THEN 0
              WHEN 'supporting' THEN 1
              WHEN 'debug' THEN 2
              ELSE 3
            END,
            artifacts.relative_path ASC
          `,
        )
        .all(input.runId, input.clientId);

  return (rowQuery as ArtifactRow[]).map(mapArtifact);
}

export function getArtifactForRunForClient(
  db: RunnerDatabase,
  input: { runId: string; artifactId: string; clientId: string; isAdmin?: boolean },
): ArtifactRecord | null {
  const row = input.isAdmin
    ? (db
        .prepare(
          `
          SELECT artifacts.*
          FROM artifacts
          JOIN runs ON runs.id = artifacts.run_id
          WHERE artifacts.run_id = ? AND artifacts.id = ?
          `,
        )
        .get(input.runId, input.artifactId) as ArtifactRow | undefined)
    : (db
        .prepare(
          `
          SELECT artifacts.*
          FROM artifacts
          JOIN runs ON runs.id = artifacts.run_id
          WHERE artifacts.run_id = ? AND artifacts.id = ? AND runs.client_id = ?
          `,
        )
        .get(input.runId, input.artifactId, input.clientId) as ArtifactRow | undefined);

  return row ? mapArtifact(row) : null;
}

export function upsertRunLogPaths(
  db: RunnerDatabase,
  input: {
    runId: string;
    stdoutLogPath: string | null;
    stderrLogPath: string | null;
    debugEventsLogPath: string | null;
    now: number;
  },
): RunLogRecord {
  assertRelativeLogPath(input.stdoutLogPath);
  assertRelativeLogPath(input.stderrLogPath);
  assertRelativeLogPath(input.debugEventsLogPath);

  db.prepare(
    `
    INSERT INTO run_logs (
      run_id, stdout_log_path, stderr_log_path, debug_events_log_path, created_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      stdout_log_path = excluded.stdout_log_path,
      stderr_log_path = excluded.stderr_log_path,
      debug_events_log_path = excluded.debug_events_log_path
    `,
  ).run(
    input.runId,
    input.stdoutLogPath,
    input.stderrLogPath,
    input.debugEventsLogPath,
    input.now,
  );

  return getRunLogByRunId(db, input.runId);
}

export function getRunLogForRunForClient(
  db: RunnerDatabase,
  input: { runId: string; clientId: string; isAdmin?: boolean },
): RunLogRecord | null {
  const row = input.isAdmin
    ? (db.prepare('SELECT * FROM run_logs WHERE run_id = ?').get(input.runId) as
        | RunLogRow
        | undefined)
    : (db
        .prepare(
          `
          SELECT run_logs.*
          FROM run_logs
          JOIN runs ON runs.id = run_logs.run_id
          WHERE run_logs.run_id = ? AND runs.client_id = ?
          `,
        )
        .get(input.runId, input.clientId) as RunLogRow | undefined);

  return row ? mapRunLog(row) : null;
}

export function listRunLogsFinishedBefore(
  db: RunnerDatabase,
  input: { finishedBefore: number; limit: number },
): RunLogRecord[] {
  const rows = db
    .prepare(
      `
      SELECT run_logs.*
      FROM run_logs
      JOIN runs ON runs.id = run_logs.run_id
      WHERE runs.finished_at IS NOT NULL
        AND runs.finished_at < ?
        AND runs.status IN ('succeeded', 'failed', 'canceled', 'interrupted')
      ORDER BY runs.finished_at ASC, run_logs.created_at ASC
      LIMIT ?
      `,
    )
    .all(input.finishedBefore, input.limit) as RunLogRow[];

  return rows.map(mapRunLog);
}

export function deleteRunLogRows(db: RunnerDatabase, runIds: readonly string[]): number {
  const deleteRows = db.transaction(() => {
    const statement = db.prepare('DELETE FROM run_logs WHERE run_id = ?');
    let changes = 0;
    for (const runId of runIds) {
      changes += statement.run(runId).changes;
    }
    return changes;
  });

  return deleteRows();
}

export function getRunDetail(
  db: RunnerDatabase,
  input: { runId: string; clientId: string; isAdmin?: boolean },
): RunDetailRecord | null {
  const row = input.isAdmin
    ? (db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as RunRow | undefined)
    : (db.prepare('SELECT * FROM runs WHERE id = ? AND client_id = ?').get(input.runId, input.clientId) as
        | RunRow
        | undefined);
  if (!row) {
    return null;
  }

  return {
    run: mapRun(row),
    messages: getRunMessages(db, input.runId),
  };
}

export function getRunForClient(
  db: RunnerDatabase,
  input: { runId: string; clientId: string; isAdmin?: boolean },
): RunRecord | null {
  const row = input.isAdmin
    ? (db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as RunRow | undefined)
    : (db.prepare('SELECT * FROM runs WHERE id = ? AND client_id = ?').get(input.runId, input.clientId) as
        | RunRow
        | undefined);
  return row ? mapRun(row) : null;
}

export function getRunWithWorkspaceForClient(
  db: RunnerDatabase,
  input: { runId: string; clientId: string; isAdmin?: boolean },
): RunWithWorkspaceRecord | null {
  const run = getRunForClient(db, input);
  if (!run) {
    return null;
  }
  return { run, workspace: getWorkspaceById(db, run.workspaceId) };
}

export function listRunsForClient(
  db: RunnerDatabase,
  input: {
    clientId: string;
    isAdmin?: boolean;
    status?: RunStatus;
    originId?: string;
    userId?: string;
    projectId?: string;
    workspaceKey?: string;
    workspacePrefix?: string;
  },
): RunRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (!input.isAdmin) {
    clauses.push('runs.client_id = ?');
    params.push(input.clientId);
  }
  if (input.status) {
    clauses.push('runs.status = ?');
    params.push(input.status);
  }
  if (input.originId) {
    clauses.push('workspaces.origin_id = ?');
    params.push(input.originId);
  }
  if (input.userId) {
    clauses.push('workspaces.user_id = ?');
    params.push(input.userId);
  }
  if (input.projectId) {
    clauses.push('workspaces.project_id = ?');
    params.push(input.projectId);
  }
  if (input.workspaceKey) {
    clauses.push('workspaces.workspace_key = ?');
    params.push(input.workspaceKey);
  }
  if (input.workspacePrefix) {
    clauses.push('workspaces.workspace_key LIKE ?');
    params.push(`${input.workspacePrefix}%`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `
      SELECT runs.*
      FROM runs
      JOIN workspaces ON workspaces.id = runs.workspace_id
      ${where}
      ORDER BY runs.created_at DESC
      `,
    )
    .all(...params) as RunRow[];

  return rows.map(mapRun);
}

function getWorkspaceById(db: RunnerDatabase, workspaceId: string): WorkspaceRecord {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
    | WorkspaceRow
    | undefined;
  if (!row) {
    throw new Error(`Workspace not found after write: ${workspaceId}`);
  }
  return mapWorkspace(row);
}

function getRunById(db: RunnerDatabase, runId: string): RunRecord {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
  if (!row) {
    throw new Error(`Run not found after write: ${runId}`);
  }
  return mapRun(row);
}

function getRunMessageById(db: RunnerDatabase, messageId: string): RunMessageRecord {
  const row = db.prepare('SELECT * FROM run_messages WHERE id = ?').get(messageId) as
    | RunMessageRow
    | undefined;
  if (!row) {
    throw new Error(`Run message not found after write: ${messageId}`);
  }
  return mapRunMessage(row);
}

function getRunLogByRunId(db: RunnerDatabase, runId: string): RunLogRecord {
  const row = db.prepare('SELECT * FROM run_logs WHERE run_id = ?').get(runId) as
    | RunLogRow
    | undefined;
  if (!row) {
    throw new Error(`Run log not found after write: ${runId}`);
  }
  return mapRunLog(row);
}

function getRunMessages(db: RunnerDatabase, runId: string): RunMessageRecord[] {
  return (
    db
      .prepare('SELECT * FROM run_messages WHERE run_id = ? ORDER BY position ASC')
      .all(runId) as RunMessageRow[]
  ).map(mapRunMessage);
}

export function getActiveRunForWorkspace(db: RunnerDatabase, workspaceId: string): RunRecord | null {
  const row = db
    .prepare(
      `
      SELECT *
      FROM runs
      WHERE workspace_id = ?
        AND status IN ('queued', 'running')
      ORDER BY created_at ASC
      LIMIT 1
      `,
    )
    .get(workspaceId) as RunRow | undefined;

  return row ? mapRun(row) : null;
}

function insertProfileSnapshot(
  db: RunnerDatabase,
  input: { runId: string; profile: unknown; now: number },
): ProfileSnapshotRecord {
  db.prepare(
    `
    INSERT INTO profile_snapshots (run_id, profile_json, created_at)
    VALUES (?, ?, ?)
    `,
  ).run(input.runId, JSON.stringify(input.profile), input.now);

  const snapshot = getProfileSnapshotForRun(db, input.runId);
  if (!snapshot) {
    throw new Error(`Profile snapshot not found after write: ${input.runId}`);
  }
  return snapshot;
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
    collectionMode: row.collection_mode,
    promptSnapshotHash: row.prompt_snapshot_hash,
    promptSnapshotCharCount: row.prompt_snapshot_char_count,
    promptSnapshotByteCount: row.prompt_snapshot_byte_count,
    promptSnapshotPersisted: row.prompt_snapshot_persisted === 1,
    businessContextHash: row.business_context_hash,
    artifactRuleIds: parseNullable(row.artifact_rule_ids_json) as string[] | null,
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

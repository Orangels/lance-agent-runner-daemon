import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import {
  createRunQueuedWithMessagesAndSnapshot,
  getActiveRunForWorkspace,
  getConversationForWorkspace,
  getRunByIdempotencyKey,
  getRunLogForRunForClient,
  getOrCreateDefaultConversation,
  getProfileSnapshotForRun,
  getRunContextSnapshot,
  getRunDetail,
  getRunPromptSnapshot,
  getRunSkillSnapshot,
  getWorkspaceForClient,
  insertRunFeedback,
  listConversationMessagesForPrompt,
  insertRunMessagesForRunCreate,
  insertAssistantRunMessage,
  insertRunQueued,
  getArtifactForRunForClient,
  listRunLogsFinishedBefore,
  listRunsForClient,
  listRunFeedbackForClient,
  listArtifactsForRun,
  markInterruptedRunsOnStartup,
  replaceArtifactsForRun,
  deleteRunLogRows,
  updateRunMessage,
  updateRunPromptSnapshotFields,
  updateRunStatus,
  updateRunTerminal,
  upsertRunPromptSnapshot,
  upsertRunSkillSnapshot,
  upsertRunLogPaths,
  upsertWorkspace,
} from '../../src/db/repositories.js';
import { applySchema } from '../../src/db/schema.js';

function setupDb() {
  const db = openInMemoryDatabase();
  applySchema(db);
  return db;
}

function insertWorkspaceFixture(db = setupDb()) {
  const workspace = upsertWorkspace(db, {
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_123',
    status: 'active',
    metadata: { label: 'Report' },
    now: 1000,
  });
  return { db, workspace };
}

describe('workspace repository', () => {
  it('upserts the same workspace identity to the same row', () => {
    const { db, workspace } = insertWorkspaceFixture();
    const again = upsertWorkspace(db, {
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
      status: 'active',
      metadata: { label: 'Updated' },
      now: 2000,
    });

    expect(again.id).toBe(workspace.id);
    expect(again.workspaceKey).toBe('lqbot/user_1/project_123');
    expect(again.updatedAt).toBe(2000);
    expect(again.metadata).toEqual({ label: 'Updated' });
  });

  it('does not let another client overwrite a workspace with the same public workspace key', () => {
    const { db, workspace } = insertWorkspaceFixture();

    const other = upsertWorkspace(db, {
      id: 'ws_other',
      clientId: 'other',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
      status: 'active',
      metadata: { label: 'Other client' },
      now: 2000,
    });

    expect(other.id).toBe('ws_other');
    expect(other.workspaceKey).toBe(workspace.workspaceKey);
    expect(getWorkspaceForClient(db, { workspaceId: workspace.id, clientId: 'lqbot' })?.metadata).toEqual({
      label: 'Report',
    });
  });

  it('does not let another profile overwrite a workspace with the same public workspace key', () => {
    const { db, workspace } = insertWorkspaceFixture();

    const other = upsertWorkspace(db, {
      id: 'ws_other_profile',
      clientId: 'lqbot',
      profileId: 'other-profile',
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
      status: 'active',
      metadata: { label: 'Other profile' },
      now: 2000,
    });

    expect(other.id).toBe('ws_other_profile');
    expect(other.workspaceKey).toBe(workspace.workspaceKey);
    expect(getWorkspaceForClient(db, { workspaceId: workspace.id, clientId: 'lqbot' })?.profileId).toBe(
      'report-docx',
    );
  });

  it('preserves existing metadata when create-or-get omits metadata', () => {
    const { db, workspace } = insertWorkspaceFixture();

    const again = upsertWorkspace(db, {
      id: 'ws_2',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_123',
      status: 'active',
      now: 2000,
    });

    expect(again.id).toBe(workspace.id);
    expect(again.metadata).toEqual({ label: 'Report' });
  });

  it('gets workspaces only for the owning client unless admin', () => {
    const { db, workspace } = insertWorkspaceFixture();

    expect(getWorkspaceForClient(db, { workspaceId: workspace.id, clientId: 'lqbot' })?.id).toBe(
      workspace.id,
    );
    expect(getWorkspaceForClient(db, { workspaceId: workspace.id, clientId: 'other' })).toBeNull();
    expect(
      getWorkspaceForClient(db, { workspaceId: workspace.id, clientId: 'admin', isAdmin: true })
        ?.id,
    ).toBe(workspace.id);
  });
});

describe('conversation repository', () => {
  it('creates or returns the default conversation for a workspace', () => {
    const { db, workspace } = insertWorkspaceFixture();

    const conversation = getOrCreateDefaultConversation(db, {
      id: 'conv_1',
      workspaceId: workspace.id,
      now: 3000,
    });
    const again = getOrCreateDefaultConversation(db, {
      id: 'conv_2',
      workspaceId: workspace.id,
      now: 4000,
    });

    expect(again.id).toBe(conversation.id);
    expect(again.workspaceId).toBe(workspace.id);
  });

  it('gets conversations only for their owning workspace', () => {
    const { db, workspace } = insertWorkspaceFixture();
    const otherWorkspace = upsertWorkspace(db, {
      id: 'ws_other',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'other',
      userId: 'user_2',
      projectId: 'project_456',
      now: 2000,
    });
    const conversation = getOrCreateDefaultConversation(db, {
      id: 'conv_1',
      workspaceId: workspace.id,
      now: 3000,
    });

    expect(getConversationForWorkspace(db, {
      conversationId: conversation.id,
      workspaceId: workspace.id,
    })?.id).toBe(conversation.id);
    expect(getConversationForWorkspace(db, {
      conversationId: conversation.id,
      workspaceId: otherWorkspace.id,
    })).toBeNull();
  });
});

describe('run repository', () => {
  it('creates queued run, default conversation, messages, and profile snapshot in one transaction', () => {
    const { db, workspace } = insertWorkspaceFixture();

    const created = createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_1',
      conversationId: 'conv_1',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Revise the report.',
      profileSnapshot: { version: 1, profileId: workspace.profileId, envKeys: ['ANTHROPIC_API_KEY'] },
      now: 5000,
    });

    expect(created.run).toMatchObject({
      id: 'run_1',
      status: 'queued',
      queuedAt: 5000,
      workspaceId: workspace.id,
    });
    expect(created.conversation).toMatchObject({ id: 'conv_1', workspaceId: workspace.id });
    expect(created.messages).toEqual([
      expect.objectContaining({ id: 'msg_user', role: 'user', content: 'Revise the report.', position: 0 }),
      expect.objectContaining({
        id: 'msg_assistant',
        role: 'assistant',
        content: '',
        thinkingContent: '',
        runStatus: 'queued',
        position: 1,
      }),
    ]);
    expect(created.profileSnapshot).toMatchObject({
      runId: 'run_1',
      profile: { version: 1, profileId: workspace.profileId, envKeys: ['ANTHROPIC_API_KEY'] },
      createdAt: 5000,
    });
    expect(getProfileSnapshotForRun(db, 'run_1')?.profile).toEqual(created.profileSnapshot.profile);
  });

  it('stores and looks up runs by client-scoped idempotency key', () => {
    const { db, workspace } = insertWorkspaceFixture();

    createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_1',
      defaultConversationId: 'conv_1',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      workspaceId: workspace.id,
      profileId: 'report-docx',
      clientId: 'lqbot',
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate.',
      artifactRuleIds: ['report-docx'],
      idempotencyKey: 'dispatch:1',
      idempotencyFingerprint: 'fingerprint-a',
      profileSnapshot: {},
      now: 1000,
    });

    expect(
      getRunByIdempotencyKey(db, {
        clientId: 'lqbot',
        profileId: 'report-docx',
        workspaceId: 'ws_1',
        idempotencyKey: 'dispatch:1',
      }),
    ).toEqual(expect.objectContaining({
      id: 'run_1',
      idempotencyKey: 'dispatch:1',
      idempotencyFingerprint: 'fingerprint-a',
    }));

    expect(
      getRunByIdempotencyKey(db, {
        clientId: 'other',
        profileId: 'report-docx',
        workspaceId: 'ws_1',
        idempotencyKey: 'dispatch:1',
      }),
    ).toBeNull();

    expect(
      getRunByIdempotencyKey(db, {
        clientId: 'lqbot',
        profileId: 'other-profile',
        workspaceId: 'ws_1',
        idempotencyKey: 'dispatch:1',
      }),
    ).toBeNull();

    expect(
      getRunByIdempotencyKey(db, {
        clientId: 'lqbot',
        profileId: 'report-docx',
        workspaceId: 'ws_2',
        idempotencyKey: 'dispatch:1',
      }),
    ).toBeNull();

    updateRunStatus(db, {
      runId: 'run_1',
      status: 'interrupted',
      now: 2000,
    });

    expect(
      getRunByIdempotencyKey(db, {
        clientId: 'lqbot',
        profileId: 'report-docx',
        workspaceId: 'ws_1',
        idempotencyKey: 'dispatch:1',
      }),
    ).toEqual(expect.objectContaining({
      id: 'run_1',
      status: 'interrupted',
    }));
  });

  it('reuses an explicit conversation when it belongs to the workspace', () => {
    const { db, workspace } = insertWorkspaceFixture();
    const conversation = getOrCreateDefaultConversation(db, {
      id: 'conv_shared',
      workspaceId: workspace.id,
      now: 3000,
    });

    const first = createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_1',
      conversationId: conversation.id,
      defaultConversationId: 'conv_default_1',
      userMessageId: 'msg_user_1',
      assistantMessageId: 'msg_assistant_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Visible request',
      promptMode: 'business-context',
      currentPrompt: 'Visible request',
      collectionMode: 'diagnostic',
      profileSnapshot: {},
      businessContextHash: 'a'.repeat(64),
      businessContext: { stage: 'codegen_harden' },
      persistBusinessContext: true,
      now: 5000,
    });
    const second = createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_2',
      conversationId: conversation.id,
      defaultConversationId: 'conv_default_2',
      userMessageId: 'msg_user_2',
      assistantMessageId: 'msg_assistant_2',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      skillId: 'report-writer',
      prompt: 'Visible follow-up',
      promptMode: 'business-context',
      currentPrompt: 'Visible follow-up',
      collectionMode: 'diagnostic',
      profileSnapshot: {},
      businessContextHash: 'b'.repeat(64),
      businessContext: { previousRunId: 'run_1' },
      persistBusinessContext: true,
      now: 6000,
    });

    expect(first.conversation.id).toBe(conversation.id);
    expect(second.conversation.id).toBe(conversation.id);
    expect(getRunDetail(db, { runId: 'run_1', clientId: workspace.clientId })?.messages[0]).toMatchObject({
      content: 'Visible request',
      conversationId: conversation.id,
    });
  });

  it('allocates stable conversation sequence across runs and assistant message segments', () => {
    const { db, workspace } = insertWorkspaceFixture();
    const conversation = getOrCreateDefaultConversation(db, {
      id: 'conv_shared',
      workspaceId: workspace.id,
      now: 3000,
    });

    const first = createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_1',
      conversationId: conversation.id,
      defaultConversationId: 'conv_default_1',
      userMessageId: 'msg_user_1',
      assistantMessageId: 'msg_assistant_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'First request.',
      profileSnapshot: { profileId: workspace.profileId },
      now: 5000,
    });
    updateRunMessage(db, {
      messageId: 'msg_assistant_1',
      content: 'First answer.',
      now: 5100,
    });
    insertAssistantRunMessage(db, {
      id: 'msg_assistant_1b',
      workspaceId: workspace.id,
      conversationId: first.conversation.id,
      runId: 'run_1',
      position: 2,
      runStatus: 'running',
      now: 5200,
    });
    updateRunMessage(db, {
      messageId: 'msg_assistant_1b',
      content: 'Second assistant segment.',
      now: 5300,
    });

    createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_2',
      conversationId: first.conversation.id,
      defaultConversationId: 'conv_default_2',
      userMessageId: 'msg_user_2',
      assistantMessageId: 'msg_assistant_2',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Second request.',
      profileSnapshot: { profileId: workspace.profileId },
      now: 6000,
    });

    expect(getRunDetail(db, { runId: 'run_1', clientId: workspace.clientId })?.messages).toEqual([
      expect.objectContaining({ id: 'msg_user_1', conversationSeq: 1 }),
      expect.objectContaining({ id: 'msg_assistant_1', conversationSeq: 2 }),
      expect.objectContaining({ id: 'msg_assistant_1b', conversationSeq: 3 }),
    ]);
    expect(getRunDetail(db, { runId: 'run_2', clientId: workspace.clientId })?.messages).toEqual([
      expect.objectContaining({ id: 'msg_user_2', conversationSeq: 4 }),
      expect.objectContaining({ id: 'msg_assistant_2', conversationSeq: 5 }),
    ]);
    expect(listConversationMessagesForPrompt(db, {
      workspaceId: workspace.id,
      conversationId: first.conversation.id,
      excludeRunId: 'run_2',
      limit: 10,
    }).map((message) => [message.id, message.role, message.content])).toEqual([
      ['msg_user_1', 'user', 'First request.'],
      ['msg_assistant_1', 'assistant', 'First answer.'],
      ['msg_assistant_1b', 'assistant', 'Second assistant segment.'],
    ]);
  });

  it('stores full business context snapshots outside lite mode', () => {
    const { db, workspace } = insertWorkspaceFixture();

    const created = createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_diag',
      defaultConversationId: 'conv_diag',
      userMessageId: 'msg_user_diag',
      assistantMessageId: 'msg_assistant_diag',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Visible request',
      promptMode: 'business-context',
      currentPrompt: 'Visible request',
      collectionMode: 'diagnostic',
      profileSnapshot: {},
      businessContextHash: 'c'.repeat(64),
      businessContext: { inputFiles: ['input/flow.py'] },
      persistBusinessContext: true,
      now: 5000,
    });

    expect(created.run.businessContextHash).toBe('c'.repeat(64));
    expect(getRunContextSnapshot(db, created.run.id)).toMatchObject({
      businessContext: { inputFiles: ['input/flow.py'] },
      businessContextHash: 'c'.repeat(64),
      persisted: true,
    });
  });

  it('stores only business context hash in lite mode', () => {
    const { db, workspace } = insertWorkspaceFixture();

    const created = createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_lite',
      defaultConversationId: 'conv_lite',
      userMessageId: 'msg_user_lite',
      assistantMessageId: 'msg_assistant_lite',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Visible request',
      promptMode: 'business-context',
      currentPrompt: 'Visible request',
      collectionMode: 'lite',
      profileSnapshot: {},
      businessContextHash: 'd'.repeat(64),
      businessContext: { inputFiles: ['input/flow.py'] },
      persistBusinessContext: false,
      now: 5000,
    });

    expect(created.run.businessContextHash).toBe('d'.repeat(64));
    expect(getRunContextSnapshot(db, created.run.id)).toMatchObject({
      businessContext: null,
      businessContextHash: 'd'.repeat(64),
      persisted: false,
    });
  });

  it('upserts prompt and skill snapshots', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate.',
      now: 5000,
    });

    upsertRunPromptSnapshot(db, {
      runId: 'run_1',
      promptSnapshot: null,
      promptSnapshotHash: 'e'.repeat(64),
      charCount: 10,
      byteCount: 10,
      persisted: false,
      now: 6000,
    });
    updateRunPromptSnapshotFields(db, {
      runId: 'run_1',
      promptSnapshotHash: 'e'.repeat(64),
      charCount: 10,
      byteCount: 10,
      persisted: false,
      now: 6000,
    });
    upsertRunSkillSnapshot(db, {
      runId: 'run_1',
      skillId: 'report-writer',
      skillName: 'Report Writer',
      skillDescription: 'Writes reports.',
      skillBodyHash: 'f'.repeat(64),
      skillBody: null,
      sideFilesManifest: [{ relativePath: 'references/style.md', size: 10, sha256: 'a'.repeat(64) }],
      persisted: false,
      now: 6000,
    });

    expect(getRunPromptSnapshot(db, 'run_1')).toMatchObject({
      promptSnapshot: null,
      promptSnapshotHash: 'e'.repeat(64),
      charCount: 10,
      byteCount: 10,
      persisted: false,
    });
    expect(getRunDetail(db, { runId: 'run_1', clientId: workspace.clientId })?.run).toMatchObject({
      promptSnapshotHash: 'e'.repeat(64),
      promptSnapshotCharCount: 10,
      promptSnapshotByteCount: 10,
      promptSnapshotPersisted: false,
    });
    expect(getRunSkillSnapshot(db, 'run_1')).toMatchObject({
      skillId: 'report-writer',
      skillName: 'Report Writer',
      skillBodyHash: 'f'.repeat(64),
      skillBody: null,
      sideFilesManifest: [{ relativePath: 'references/style.md', size: 10, sha256: 'a'.repeat(64) }],
      persisted: false,
    });
  });

  it('reuses the default conversation inside the create transaction', () => {
    const { db, workspace } = insertWorkspaceFixture();
    const existing = getOrCreateDefaultConversation(db, {
      id: 'conv_existing',
      workspaceId: workspace.id,
      now: 3000,
    });

    const created = createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_1',
      conversationId: 'conv_new',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Revise the report.',
      profileSnapshot: { version: 1, profileId: workspace.profileId },
      now: 5000,
    });

    expect(created.conversation.id).toBe(existing.id);
    expect(created.messages.map((message) => message.conversationId)).toEqual([existing.id, existing.id]);
  });

  it('rolls back run, messages, conversation, and snapshot when snapshot insert fails', () => {
    const { db, workspace } = insertWorkspaceFixture();
    const circular: Record<string, unknown> = { profileId: workspace.profileId };
    circular.self = circular;

    expect(() =>
      createRunQueuedWithMessagesAndSnapshot(db, {
        runId: 'run_1',
        conversationId: 'conv_1',
        userMessageId: 'msg_user',
        assistantMessageId: 'msg_assistant',
        workspaceId: workspace.id,
        profileId: workspace.profileId,
        clientId: workspace.clientId,
        kind: 'revise',
        prompt: 'Revise the report.',
        profileSnapshot: circular,
        now: 5000,
      }),
    ).toThrow();

    expect(getRunDetail(db, { runId: 'run_1', clientId: workspace.clientId })).toBeNull();
    expect(getProfileSnapshotForRun(db, 'run_1')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM run_messages').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 0 });
  });

  it('allows multiple queued runs for the same workspace in the create transaction', () => {
    const { db, workspace } = insertWorkspaceFixture();
    createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_1',
      conversationId: 'conv_1',
      userMessageId: 'msg_user_1',
      assistantMessageId: 'msg_assistant_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'First run.',
      profileSnapshot: { version: 1, profileId: workspace.profileId },
      now: 5000,
    });

    const second = createRunQueuedWithMessagesAndSnapshot(db, {
      runId: 'run_2',
      conversationId: 'conv_2',
      userMessageId: 'msg_user_2',
      assistantMessageId: 'msg_assistant_2',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Second run.',
      profileSnapshot: { version: 1, profileId: workspace.profileId },
      now: 6000,
    });

    expect(second.run).toMatchObject({ id: 'run_2', status: 'queued' });
    expect(second.messages).toEqual([
      expect.objectContaining({ id: 'msg_user_2', role: 'user', content: 'Second run.' }),
      expect.objectContaining({ id: 'msg_assistant_2', role: 'assistant', runStatus: 'queued' }),
    ]);
    expect(listRunsForClient(db, { clientId: workspace.clientId }).map((run) => run.id)).toEqual([
      'run_2',
      'run_1',
    ]);
  });

  it('finds active runs for a workspace and ignores terminal runs', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'run_done',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Done.',
      now: 5000,
    });
    updateRunTerminal(db, {
      runId: 'run_done',
      status: 'succeeded',
      finishedAt: 6000,
      exitCode: 0,
      signal: null,
      now: 6000,
    });

    expect(getActiveRunForWorkspace(db, workspace.id)).toBeNull();

    insertRunQueued(db, {
      id: 'run_active',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Active.',
      now: 7000,
    });

    expect(getActiveRunForWorkspace(db, workspace.id)?.id).toBe('run_active');
  });

  it('persists terminal signal exits with a null exit code', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Run.',
      now: 5000,
    });

    const run = updateRunTerminal(db, {
      runId: 'run_1',
      status: 'canceled',
      finishedAt: 7000,
      exitCode: null,
      signal: 'SIGTERM',
      errorCode: null,
      errorMessage: null,
      now: 7000,
    });

    expect(run).toMatchObject({
      status: 'canceled',
      finishedAt: 7000,
      exitCode: null,
      signal: 'SIGTERM',
      errorCode: null,
      errorMessage: null,
    });
  });

  it('inserts runs as queued immediately', () => {
    const { db, workspace } = insertWorkspaceFixture();

    const run = insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: 'report-docx',
      clientId: 'lqbot',
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate the report.',
      artifactRuleIds: ['report-docx'],
      metadata: { businessMessageId: 'msg_1' },
      now: 5000,
    });

    expect(run.status).toBe('queued');
    expect(run.queuedAt).toBe(5000);
    expect(run.createdAt).toBe(5000);
    expect(run.artifactRuleIds).toEqual(['report-docx']);
  });

  it('marks old queued and running runs interrupted on startup', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'run_queued',
      workspaceId: workspace.id,
      profileId: 'report-docx',
      clientId: 'lqbot',
      kind: 'revise',
      prompt: 'Queued',
      now: 5000,
    });
    insertRunQueued(db, {
      id: 'run_running',
      workspaceId: workspace.id,
      profileId: 'report-docx',
      clientId: 'lqbot',
      kind: 'revise',
      prompt: 'Running',
      now: 5000,
    });
    updateRunStatus(db, {
      runId: 'run_running',
      status: 'running',
      startedAt: 5500,
      now: 5500,
    });

    const changed = markInterruptedRunsOnStartup(db, 9000);

    expect(changed).toBe(2);
    expect(getRunDetail(db, { runId: 'run_queued', clientId: 'lqbot' })?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
      finishedAt: 9000,
    });
    expect(getRunDetail(db, { runId: 'run_running', clientId: 'lqbot' })?.run).toMatchObject({
      status: 'interrupted',
      errorCode: 'RUN_INTERRUPTED_BY_DAEMON_RESTART',
      finishedAt: 9000,
    });
  });

  it('lists runs scoped to client and filters by status', () => {
    const { db, workspace } = insertWorkspaceFixture();
    const otherWorkspace = upsertWorkspace(db, {
      id: 'ws_other',
      clientId: 'other',
      profileId: 'report-docx',
      originId: 'other',
      userId: 'user_2',
      projectId: 'project_456',
      status: 'active',
      now: 1000,
    });
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: 'report-docx',
      clientId: 'lqbot',
      kind: 'revise',
      prompt: 'Run 1',
      now: 5000,
    });
    insertRunQueued(db, {
      id: 'run_2',
      workspaceId: otherWorkspace.id,
      profileId: 'report-docx',
      clientId: 'other',
      kind: 'revise',
      prompt: 'Run 2',
      now: 6000,
    });

    expect(listRunsForClient(db, { clientId: 'lqbot', status: 'queued' }).map((run) => run.id)).toEqual([
      'run_1',
    ]);
  });
});

describe('run log repository', () => {
  it('upserts relative log paths and reads them for the owning client', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Run.',
      now: 5000,
    });

    const record = upsertRunLogPaths(db, {
      runId: 'run_1',
      stdoutLogPath: 'logs/runs/run_1/stdout.log',
      stderrLogPath: 'logs/runs/run_1/stderr.log',
      debugEventsLogPath: 'logs/runs/run_1/debug-events.ndjson',
      now: 6000,
    });

    expect(record).toEqual({
      runId: 'run_1',
      stdoutLogPath: 'logs/runs/run_1/stdout.log',
      stderrLogPath: 'logs/runs/run_1/stderr.log',
      debugEventsLogPath: 'logs/runs/run_1/debug-events.ndjson',
      createdAt: 6000,
    });
    expect(getRunLogForRunForClient(db, { runId: 'run_1', clientId: workspace.clientId })).toEqual(record);
  });

  it('rejects absolute log paths', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Run.',
      now: 5000,
    });

    expect(() =>
      upsertRunLogPaths(db, {
        runId: 'run_1',
        stdoutLogPath: '/tmp/stdout.log',
        stderrLogPath: null,
        debugEventsLogPath: null,
        now: 6000,
      }),
    ).toThrow(/relative/);
  });

  it('scopes run log reads by client unless admin', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Run.',
      now: 5000,
    });
    const record = upsertRunLogPaths(db, {
      runId: 'run_1',
      stdoutLogPath: 'logs/runs/run_1/stdout.log',
      stderrLogPath: null,
      debugEventsLogPath: null,
      now: 6000,
    });

    expect(getRunLogForRunForClient(db, { runId: 'run_1', clientId: 'other' })).toBeNull();
    expect(getRunLogForRunForClient(db, { runId: 'run_1', clientId: 'admin', isAdmin: true })).toEqual(
      record,
    );
  });

  it('lists and deletes log rows for terminal runs finished before a cutoff', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'old',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Old.',
      now: 5000,
    });
    updateRunTerminal(db, {
      runId: 'old',
      status: 'succeeded',
      finishedAt: 6000,
      now: 6000,
    });
    upsertRunLogPaths(db, {
      runId: 'old',
      stdoutLogPath: 'logs/runs/old/stdout.log',
      stderrLogPath: null,
      debugEventsLogPath: null,
      now: 6100,
    });
    insertRunQueued(db, {
      id: 'new',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'New.',
      now: 7000,
    });
    updateRunTerminal(db, {
      runId: 'new',
      status: 'succeeded',
      finishedAt: 9000,
      now: 9000,
    });
    upsertRunLogPaths(db, {
      runId: 'new',
      stdoutLogPath: 'logs/runs/new/stdout.log',
      stderrLogPath: null,
      debugEventsLogPath: null,
      now: 9100,
    });

    expect(listRunLogsFinishedBefore(db, { finishedBefore: 8000, limit: 10 }).map((record) => record.runId)).toEqual([
      'old',
    ]);

    expect(deleteRunLogRows(db, ['old'])).toBe(1);
    expect(getRunLogForRunForClient(db, { runId: 'old', clientId: workspace.clientId })).toBeNull();
    expect(getRunLogForRunForClient(db, { runId: 'new', clientId: workspace.clientId })?.runId).toBe('new');
  });
});

describe('run feedback repository', () => {
  it('stores feedback for a run and scopes reads by client unless admin', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'revise',
      prompt: 'Run.',
      now: 5000,
    });

    insertRunFeedback(db, {
      id: 'feedback_1',
      runId: 'run_1',
      clientId: workspace.clientId,
      category: 'prompt',
      message: 'Ask for parameters before generating.',
      metadata: { artifactPath: 'output/result.json' },
      now: 6000,
    });
    insertRunFeedback(db, {
      id: 'feedback_2',
      runId: 'run_1',
      clientId: workspace.clientId,
      category: 'custom.selector',
      message: 'Selector looks brittle.',
      metadata: null,
      now: 7000,
    });

    expect(listRunFeedbackForClient(db, { runId: 'run_1', clientId: workspace.clientId })).toEqual([
      {
        id: 'feedback_1',
        runId: 'run_1',
        clientId: workspace.clientId,
        category: 'prompt',
        message: 'Ask for parameters before generating.',
        metadata: { artifactPath: 'output/result.json' },
        createdAt: 6000,
      },
      {
        id: 'feedback_2',
        runId: 'run_1',
        clientId: workspace.clientId,
        category: 'custom.selector',
        message: 'Selector looks brittle.',
        metadata: null,
        createdAt: 7000,
      },
    ]);
    expect(listRunFeedbackForClient(db, { runId: 'run_1', clientId: 'other' })).toBeNull();
    expect(listRunFeedbackForClient(db, { runId: 'run_1', clientId: 'admin', isAdmin: true })?.[0]).toMatchObject({
      runId: 'run_1',
      clientId: workspace.clientId,
      category: 'prompt',
    });
  });
});

describe('run message repository', () => {
  it('inserts user and assistant draft messages at run creation', () => {
    const { db, workspace } = insertWorkspaceFixture();
    const conversation = getOrCreateDefaultConversation(db, {
      id: 'conv_1',
      workspaceId: workspace.id,
      now: 3000,
    });
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: 'report-docx',
      clientId: 'lqbot',
      kind: 'revise',
      prompt: 'Revise the report.',
      now: 5000,
    });

    insertRunMessagesForRunCreate(db, {
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      workspaceId: workspace.id,
      conversationId: conversation.id,
      runId: 'run_1',
      prompt: 'Revise the report.',
      now: 5000,
    });

    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.messages).toEqual([
      expect.objectContaining({ id: 'msg_user', role: 'user', content: 'Revise the report.', position: 0 }),
      expect.objectContaining({
        id: 'msg_assistant',
        role: 'assistant',
        content: '',
        thinkingContent: '',
        runStatus: 'queued',
        position: 1,
      }),
    ]);
  });

  it('updates run messages by message id', () => {
    const { db, workspace } = insertWorkspaceFixture();
    const conversation = getOrCreateDefaultConversation(db, {
      id: 'conv_1',
      workspaceId: workspace.id,
      now: 3000,
    });
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: 'report-docx',
      clientId: 'lqbot',
      kind: 'revise',
      prompt: 'Revise the report.',
      now: 5000,
    });
    insertRunMessagesForRunCreate(db, {
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      workspaceId: workspace.id,
      conversationId: conversation.id,
      runId: 'run_1',
      prompt: 'Revise the report.',
      now: 5000,
    });

    updateRunMessage(db, {
      messageId: 'msg_assistant',
      content: 'Done.',
      thinkingContent: 'Thought it through.',
      events: [{ type: 'text_delta', text: 'Done.' }],
      runStatus: 'succeeded',
      lastRunEventId: 'evt_1',
      endedAt: 7000,
      now: 7000,
    });

    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.messages[1]).toMatchObject({
      content: 'Done.',
      thinkingContent: 'Thought it through.',
      events: [{ type: 'text_delta', text: 'Done.' }],
      runStatus: 'succeeded',
      lastRunEventId: 'evt_1',
      endedAt: 7000,
    });
  });
});

describe('artifact repository', () => {
  it('replaces artifacts for one run and maps metadata', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate.',
      now: 5000,
    });

    const inserted = replaceArtifactsForRun(db, {
      runId: 'run_1',
      workspaceId: workspace.id,
      artifacts: [
        {
          id: 'artifact_1',
          ruleId: 'report-docx',
          role: 'primary',
          relativePath: 'output/report.docx',
          fileName: 'report.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 123,
          mtime: 7000,
          sha256: 'abc123',
          metadata: { pageCount: 2 },
        },
      ],
      now: 8000,
    });

    expect(inserted).toEqual([
      expect.objectContaining({
        id: 'artifact_1',
        runId: 'run_1',
        workspaceId: workspace.id,
        ruleId: 'report-docx',
        role: 'primary',
        relativePath: 'output/report.docx',
        fileName: 'report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 123,
        mtime: 7000,
        sha256: 'abc123',
        metadata: { pageCount: 2 },
        createdAt: 8000,
      }),
    ]);
  });

  it('deletes stale artifacts for the run being replaced only', () => {
    const { db, workspace } = insertWorkspaceFixture();
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'generate',
      prompt: 'Generate 1.',
      now: 5000,
    });
    updateRunTerminal(db, {
      runId: 'run_1',
      status: 'succeeded',
      finishedAt: 6000,
      now: 6000,
    });
    insertRunQueued(db, {
      id: 'run_2',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'generate',
      prompt: 'Generate 2.',
      now: 7000,
    });

    replaceArtifactsForRun(db, {
      runId: 'run_1',
      workspaceId: workspace.id,
      artifacts: [
        {
          id: 'stale',
          ruleId: 'report-docx',
          role: 'primary',
          relativePath: 'output/stale.docx',
          fileName: 'stale.docx',
        },
      ],
      now: 8000,
    });
    replaceArtifactsForRun(db, {
      runId: 'run_2',
      workspaceId: workspace.id,
      artifacts: [
        {
          id: 'other',
          ruleId: 'report-docx',
          role: 'primary',
          relativePath: 'output/other.docx',
          fileName: 'other.docx',
        },
      ],
      now: 8100,
    });

    replaceArtifactsForRun(db, {
      runId: 'run_1',
      workspaceId: workspace.id,
      artifacts: [
        {
          id: 'fresh',
          ruleId: 'report-docx',
          role: 'primary',
          relativePath: 'output/fresh.docx',
          fileName: 'fresh.docx',
        },
      ],
      now: 8200,
    });

    expect(listArtifactsForRun(db, { runId: 'run_1', clientId: workspace.clientId }).map((artifact) => artifact.id)).toEqual([
      'fresh',
    ]);
    expect(listArtifactsForRun(db, { runId: 'run_2', clientId: workspace.clientId }).map((artifact) => artifact.id)).toEqual([
      'other',
    ]);
  });

  it('lists and gets artifacts scoped by client unless admin', () => {
    const { db, workspace } = insertWorkspaceFixture();
    const otherWorkspace = upsertWorkspace(db, {
      id: 'ws_other',
      clientId: 'other',
      profileId: 'report-docx',
      originId: 'other',
      userId: 'user_2',
      projectId: 'project_456',
      status: 'active',
      now: 1000,
    });
    insertRunQueued(db, {
      id: 'run_1',
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      clientId: workspace.clientId,
      kind: 'generate',
      prompt: 'Generate 1.',
      now: 5000,
    });
    insertRunQueued(db, {
      id: 'run_2',
      workspaceId: otherWorkspace.id,
      profileId: otherWorkspace.profileId,
      clientId: otherWorkspace.clientId,
      kind: 'generate',
      prompt: 'Generate 2.',
      now: 6000,
    });
    replaceArtifactsForRun(db, {
      runId: 'run_1',
      workspaceId: workspace.id,
      artifacts: [
        {
          id: 'artifact_1',
          ruleId: 'report-docx',
          role: 'primary',
          relativePath: 'output/report.docx',
          fileName: 'report.docx',
        },
      ],
      now: 7000,
    });
    replaceArtifactsForRun(db, {
      runId: 'run_2',
      workspaceId: otherWorkspace.id,
      artifacts: [
        {
          id: 'artifact_2',
          ruleId: 'report-docx',
          role: 'primary',
          relativePath: 'output/other.docx',
          fileName: 'other.docx',
        },
      ],
      now: 7100,
    });

    expect(listArtifactsForRun(db, { runId: 'run_1', clientId: 'other' })).toEqual([]);
    expect(getArtifactForRunForClient(db, { runId: 'run_1', artifactId: 'artifact_1', clientId: 'other' })).toBeNull();
    expect(listArtifactsForRun(db, { runId: 'run_1', clientId: 'admin', isAdmin: true }).map((artifact) => artifact.id)).toEqual([
      'artifact_1',
    ]);
    expect(getArtifactForRunForClient(db, { runId: 'run_2', artifactId: 'artifact_2', clientId: 'admin', isAdmin: true })?.relativePath).toBe(
      'output/other.docx',
    );
  });
});

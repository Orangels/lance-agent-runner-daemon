import { describe, expect, it } from 'vitest';
import { openInMemoryDatabase } from '../connection.js';
import {
  getOrCreateDefaultConversation,
  getRunDetail,
  getWorkspaceForClient,
  insertRunMessagesForRunCreate,
  insertRunQueued,
  listRunsForClient,
  markInterruptedRunsOnStartup,
  updateRunMessage,
  updateRunStatus,
  upsertWorkspace,
} from '../repositories.js';
import { applySchema } from '../schema.js';

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
});

describe('run repository', () => {
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
      expect.objectContaining({ id: 'msg_assistant', role: 'assistant', content: '', runStatus: 'queued', position: 1 }),
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
      events: [{ type: 'text_delta', text: 'Done.' }],
      runStatus: 'succeeded',
      lastRunEventId: 'evt_1',
      endedAt: 7000,
      now: 7000,
    });

    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.messages[1]).toMatchObject({
      content: 'Done.',
      events: [{ type: 'text_delta', text: 'Done.' }],
      runStatus: 'succeeded',
      lastRunEventId: 'evt_1',
      endedAt: 7000,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createRunFeedbackService, type RunFeedbackClient } from '../../src/core/run-feedback-service.js';
import { openInMemoryDatabase } from '../../src/db/connection.js';
import {
  createRunQueuedWithMessagesAndSnapshot,
  upsertWorkspace,
} from '../../src/db/repositories.js';
import { applySchema } from '../../src/db/schema.js';

function setup() {
  const db = openInMemoryDatabase();
  applySchema(db);
  const workspace = upsertWorkspace(db, {
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_1',
    now: 1000,
  });
  createRunQueuedWithMessagesAndSnapshot(db, {
    runId: 'run_1',
    conversationId: 'conv_1',
    userMessageId: 'msg_user',
    assistantMessageId: 'msg_assistant',
    workspaceId: workspace.id,
    profileId: workspace.profileId,
    clientId: workspace.clientId,
    kind: 'revise',
    prompt: 'Run.',
    profileSnapshot: { profileId: workspace.profileId },
    now: 2000,
  });
  const service = createRunFeedbackService({
    db,
    clock: () => 3000,
    ids: { feedbackId: () => 'feedback_1' },
  });
  return { service };
}

const client = (input: Partial<RunFeedbackClient> = {}): RunFeedbackClient => ({
  id: input.id ?? 'lqbot',
  isAdmin: input.isAdmin ?? false,
});

describe('run feedback service', () => {
  it('stores sanitized feedback for a readable run', async () => {
    const { service } = setup();

    const feedback = await service.createRunFeedback({
      runId: 'run_1',
      client: client(),
      category: 'custom.selector',
      message: 'password=hunter2 should be parameterized',
      metadata: {
        token: 'secret-token',
        artifactPath: 'output/result.json',
        localPath: '/home/orangels/private.txt',
      },
    });

    expect(feedback).toEqual({
      id: 'feedback_1',
      runId: 'run_1',
      clientId: 'lqbot',
      category: 'custom.selector',
      message: 'password=[redacted] should be parameterized',
      metadata: {
        token: '[redacted]',
        artifactPath: 'output/result.json',
        localPath: '[redacted-path]',
      },
      createdAt: 3000,
    });
    await expect(service.listRunFeedback({ runId: 'run_1', client: client() })).resolves.toEqual([feedback]);
  });

  it('returns not found for another non-admin client', async () => {
    const { service } = setup();

    await expect(
      service.createRunFeedback({
        runId: 'run_1',
        client: client({ id: 'other' }),
        category: 'prompt',
        message: 'Cannot see this run.',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }));
    await expect(service.listRunFeedback({ runId: 'run_1', client: client({ id: 'other' }) })).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
    );
  });
});

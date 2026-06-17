import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRunFeedbackService, type RunFeedbackClient } from '../../src/core/run-feedback-service.js';
import { createPostgresFilePersistenceHarness } from '../helpers/postgres-persistence-harness.js';
import { postgresTestHookTimeoutMs, requirePostgresTestUrl } from '../helpers/postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;

let harness: Awaited<ReturnType<typeof createPostgresFilePersistenceHarness>> | null = null;

beforeAll(async () => {
  harness = await createPostgresFilePersistenceHarness();
  expect(harness).not.toBeNull();
}, postgresTestHookTimeoutMs);

afterEach(async () => {
  await harness?.resetData();
});

afterAll(async () => {
  await harness?.cleanup();
  harness = null;
});

async function setup() {
  expect(harness).not.toBeNull();
  const persistence = harness!.persistence;
  const workspace = await persistence.upsertWorkspace({
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_1',
    now: 1000,
  });
  await persistence.createRunQueuedWithMessagesAndSnapshot({
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
    persistence,
    clock: () => 3000,
    ids: { feedbackId: () => 'feedback_1' },
  });
  return { service };
}

const client = (input: Partial<RunFeedbackClient> = {}): RunFeedbackClient => ({
  id: input.id ?? 'lqbot',
  isAdmin: input.isAdmin ?? false,
});

postgresDescribe('run feedback service', () => {
  it('stores sanitized feedback for a readable run', async () => {
    const { service } = await setup();

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
    const { service } = await setup();

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

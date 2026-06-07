import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { requiredGenerationArtifactNames } from '../../src/shared/artifacts.js';
import type {
  ArtifactsResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateWorkspaceRequest,
  PublicWorkspace,
} from '../../src/shared/daemon-types.js';
import { createMinimalRpaDsl } from '../../src/shared/dsl-schema.js';
import { createNaturalLanguageSessionStore } from '../../src/server/natural-language/nl-session-store.js';
import {
  createNaturalLanguageGenerationWorkflow,
  type NaturalLanguageDaemonClient,
  type NaturalLanguageExecutionReader,
} from '../../src/server/workflows/natural-language-generation-workflow.js';

async function createHarness(events: unknown[] = successfulEvents()) {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-nl-workflow-'));
  const store = createNaturalLanguageSessionStore({ storageRoot, idFactory: () => 'nl_abc123' });
  const session = await store.createSession({
    flowId: 'case_query',
    flowName: 'Case query',
    targetUrl: 'https://example.com/cases',
    requirement: 'Open the cases page and search by case number.',
    businessConstraints: 'No login and no writes.',
    safetyNotes: 'Ask before any submit action.',
  });
  const daemon = new FakeDaemonClient(events);
  const executionReader = new FakeExecutionReader();
  const workflow = createNaturalLanguageGenerationWorkflow({
    daemonClient: daemon,
    defaultProfileId: 'rpa-local',
    executionReader,
    storageRoot,
    store,
  });

  return { daemon, executionReader, session, storageRoot, store, workflow };
}

describe('natural-language generation workflow', () => {
  it('creates a daemon workspace and starts generate + business-context + rpa-script-generate', async () => {
    const { daemon, session, workflow } = await createHarness();

    await workflow.startGeneration(session.sessionId);

    expect(daemon.createWorkspace).toHaveBeenCalledWith({
      profileId: 'rpa-local',
      workspace: {
        originId: 'rpa-local-web',
        userId: 'local-user',
        projectId: 'nl_case_query_nl_abc123',
      },
      metadata: {
        naturalLanguageSessionId: 'nl_abc123',
        flowId: 'case_query',
        source: 'natural-language',
      },
    });
    expect(daemon.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'rpa-local',
        workspaceId: 'ws_1',
        kind: 'generate',
        promptMode: 'business-context',
        skillId: 'rpa-script-generate',
        collectionMode: 'diagnostic',
        eventVisibility: 'normal',
        businessContext: expect.objectContaining({
          stage: 'nl-generation',
          naturalLanguageSessionId: 'nl_abc123',
          flowId: 'case_query',
          flowName: 'Case query',
          targetUrl: 'https://example.com/cases',
          requirement: 'Open the cases page and search by case number.',
          exploration: expect.objectContaining({ chromeDevtoolsMcp: 'profile-provided' }),
        }),
      }),
    );
    expect(JSON.stringify(daemon.createRun.mock.calls[0]?.[0])).not.toContain('"prompt"');
  });

  it('moves to needs_input when Claude Code returns a question-form', async () => {
    const questionForm = `<question-form id="qf_1" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[{"id":"date","type":"text","label":"日期"}]}
</question-form>`;
    const { session, store, workflow } = await createHarness([
      { type: 'text_delta', delta: questionForm },
      { type: 'end', status: 'succeeded' },
    ]);

    await workflow.startGeneration(session.sessionId);

    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'needs_input',
      questionForm: { formId: 'qf_1' },
      artifacts: [],
    });
  });

  it('creates a revise run with form answers after question-form submission', async () => {
    const questionForm = `<question-form id="qf_1" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[{"id":"date","type":"text","label":"日期"}]}
</question-form>`;
    const { daemon, session, store, workflow } = await createHarness([
      { type: 'text_delta', delta: questionForm },
      { type: 'end', status: 'succeeded' },
    ]);
    await workflow.startGeneration(session.sessionId);
    daemon.events = successfulEvents();

    await workflow.submitQuestionAnswers(session.sessionId, {
      formId: 'qf_1',
      answers: { date: '2026-06-06' },
    });

    expect(daemon.createRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: 'ws_1',
        conversationId: 'conv_1',
        kind: 'revise',
        promptMode: 'business-context',
        skillId: 'rpa-script-generate',
        businessContext: expect.objectContaining({
          stage: 'nl-generation-follow-up',
          previousRunId: 'run_1',
          flowName: 'Case query',
          formAnswers: { date: '2026-06-06' },
          artifactPaths: expect.arrayContaining(['output/flow.dsl.json', 'output/flow.hardened.py']),
        }),
      }),
    );
    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({ status: 'generated' });
  });

  it('downloads and validates required artifacts into the final flow', async () => {
    const { session, storageRoot, store, workflow } = await createHarness();

    await workflow.startGeneration(session.sessionId);

    for (const name of requiredGenerationArtifactNames) {
      await expect(readFile(path.join(storageRoot, 'flows', 'case_query', name), 'utf8')).resolves.toContain(
        name === 'flow.dsl.json' ? '"flow_id": "case_query"' : '',
      );
    }
    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'generated',
      artifacts: expect.arrayContaining([
        expect.objectContaining({ fileName: 'flow.dsl.json', relativePath: 'output/flow.dsl.json' }),
      ]),
    });
  });

  it('creates a repair revise run from execution failure evidence', async () => {
    const { daemon, executionReader, session, store, workflow } = await createHarness();
    await workflow.startGeneration(session.sessionId);
    daemon.events = successfulEvents();
    executionReader.status = {
      status: 'failed',
      failedStepId: 'step_003',
      error: { code: 'STEP_TARGET_NOT_FOUND', message: 'target not found' },
    };

    await workflow.repairFromExecutionFailure(session.sessionId, {
      executionId: 'exec_1',
      instruction: 'Fix the failed selector.',
    });

    expect(daemon.createRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'revise',
        promptMode: 'business-context',
        skillId: 'rpa-script-generate',
        businessContext: expect.objectContaining({
          stage: 'nl-generation-repair',
          previousRunId: 'run_1',
          flowName: 'Case query',
          executionFailure: expect.objectContaining({
            executionId: 'exec_1',
            failedStepId: 'step_003',
            error: { code: 'STEP_TARGET_NOT_FOUND', message: 'target not found' },
            logTail: expect.stringContaining('stderr tail'),
          }),
          currentArtifacts: expect.arrayContaining(['output/flow.dsl.json', 'output/flow.hardened.py']),
        }),
      }),
    );
    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({ status: 'generated' });
  });

  it('marks the session failed when the daemon run does not succeed', async () => {
    const { session, store, workflow } = await createHarness([{ type: 'end', status: 'failed' }]);

    await workflow.startGeneration(session.sessionId);

    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'DAEMON_RUN_FAILED' },
    });
  });

  it('marks generated sessions failed when invalid question-form answers are submitted', async () => {
    const { session, store, workflow } = await createHarness();
    await workflow.startGeneration(session.sessionId);

    await workflow.submitQuestionAnswers(session.sessionId, {
      formId: 'missing',
      answers: { date: '2026-06-06' },
    });

    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'SESSION_NOT_WAITING_FOR_INPUT' },
    });
  });

  it('cancels active daemon runs without attaching daemon failure errors', async () => {
    const { daemon, session, store, workflow } = await createHarness([{ type: 'status', label: 'running' }]);
    const running = workflow.startGeneration(session.sessionId);
    await vi.waitFor(() => expect(daemon.createRun).toHaveBeenCalled());

    await workflow.cancel(session.sessionId);
    daemon.finishEvents();
    await running;

    expect(daemon.cancelRun).toHaveBeenCalledWith('run_1');
    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'cancelled',
      error: null,
    });
  });
});

function successfulEvents(): unknown[] {
  return [
    ...requiredGenerationArtifactNames.map((name) => ({
      type: 'artifact_finalized',
      artifact: artifact(name),
    })),
    { type: 'end', status: 'succeeded' },
  ];
}

function artifact(fileName: string) {
  return {
    id: `art_${fileName}`,
    runId: 'run_1',
    workspaceId: 'ws_1',
    ruleId: 'rpa-output',
    role: 'primary' as const,
    relativePath: `output/${fileName}`,
    fileName,
    mimeType: fileName.endsWith('.json') ? 'application/json' : 'text/plain',
    size: 100,
    mtime: 1,
    sha256: 'a'.repeat(64),
  };
}

class FakeDaemonClient implements NaturalLanguageDaemonClient {
  events: unknown[];
  private pendingController?: ReadableStreamDefaultController<unknown>;

  readonly createWorkspace = vi.fn(
    async (_request: CreateWorkspaceRequest): Promise<PublicWorkspace> => ({
      workspaceId: 'ws_1',
      workspaceKey: 'rpa/local/nl',
    }),
  );

  readonly createRun = vi.fn(
    async (_request: CreateRunRequest): Promise<CreateRunResponse> => ({
      runId: `run_${this.createRun.mock.calls.length}`,
      status: 'queued',
      conversationId: 'conv_1',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    }),
  );

  readonly listRunArtifacts = vi.fn(async (): Promise<ArtifactsResponse> => ({
    artifacts: requiredGenerationArtifactNames.map(artifact),
  }));

  readonly downloadArtifact = vi.fn(async ({ artifactId }: { runId: string; artifactId: string }) => {
    const fileName = artifactId.replace(/^art_/, '');
    const body =
      fileName === 'flow.dsl.json'
        ? JSON.stringify({ ...createMinimalRpaDsl(), flow_id: 'case_query', meta: { ...createMinimalRpaDsl().meta, source: 'nl' } }, null, 2)
        : `${fileName}\n`;
    return new Response(body);
  });

  readonly cancelRun = vi.fn(async () => ({ ok: true as const }));

  constructor(events: unknown[]) {
    this.events = events;
  }

  async *subscribeRunEvents(): AsyncGenerator<{ id: string; event: unknown }> {
    if (this.events.some((event) => isRecord(event) && event.type === 'status')) {
      yield { id: '1', event: this.events[0] };
      await new Promise<void>((resolve) => {
        const stream = new ReadableStream<unknown>({
          start: (controller) => {
            this.pendingController = controller;
          },
          cancel: () => resolve(),
        });
        const reader = stream.getReader();
        reader.closed.then(resolve, resolve);
      });
      return;
    }

    let id = 1;
    for (const event of this.events) {
      yield { id: String(id++), event };
    }
  }

  finishEvents(): void {
    this.pendingController?.close();
  }
}

class FakeExecutionReader implements NaturalLanguageExecutionReader {
  status = {
    status: 'failed',
    failedStepId: 'step_001',
    error: { code: 'FAILED', message: 'failed' },
  };

  readonly getStatus = vi.fn(async () => this.status);
  readonly getLogs = vi.fn(async () => ({ stdout: 'stdout tail', stderr: 'stderr tail' }));
  readonly listArtifacts = vi.fn(async () => ({
    artifacts: [
      { role: 'screenshot', relativePath: 'screenshots/current.png' },
      { role: 'trace', relativePath: 'trace/trace.zip' },
    ],
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

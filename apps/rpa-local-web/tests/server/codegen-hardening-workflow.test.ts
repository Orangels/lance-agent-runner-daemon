import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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
import { createCodegenSessionStore } from '../../src/server/codegen/codegen-session-store.js';
import {
  createCodegenHardeningWorkflow,
  type CodegenHardeningDaemonClient,
} from '../../src/server/workflows/codegen-hardening-workflow.js';

async function createHarness(events: unknown[] = successfulEvents()) {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-codegen-workflow-'));
  const store = createCodegenSessionStore({ storageRoot, idFactory: () => 'cg_abc123' });
  const session = await store.createSession({
    flowId: 'case_query',
    flowName: 'Case query',
    targetUrl: 'https://example.com/cases',
  });
  await store.setRecording(session.sessionId);
  await store.transition(session.sessionId, 'completed');
  await mkdir(path.dirname(session.recording.absoluteInputPath), { recursive: true });
  await writeFile(session.recording.absoluteInputPath, '# recorded codegen script\n', 'utf8');

  const daemon = new FakeDaemonClient(events);
  const workflow = createCodegenHardeningWorkflow({
    daemonClient: daemon,
    defaultProfileId: 'rpa-local',
    storageRoot,
    store,
  });

  return { daemon, session, storageRoot, store, workflow };
}

describe('codegen hardening workflow', () => {
  it('creates a per-session daemon workspace, uploads flow.py, and creates a business-context run', async () => {
    const { daemon, session, workflow } = await createHarness();

    await workflow.startHardening(session.sessionId);

    expect(daemon.createWorkspace).toHaveBeenCalledWith({
      profileId: 'rpa-local',
      workspace: {
        originId: 'rpa-local-web',
        userId: 'local-user',
        projectId: 'codegen_case_query_cg_abc123',
      },
      metadata: {
        codegenSessionId: 'cg_abc123',
        flowId: 'case_query',
        source: 'playwright-codegen',
      },
    });
    expect(daemon.uploadWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws_1',
        targetPath: 'input/flow.py',
        fileName: 'flow.py',
      }),
    );
    expect(daemon.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'rpa-local',
        workspaceId: 'ws_1',
        kind: 'generate',
        promptMode: 'business-context',
        currentPrompt: expect.stringContaining('input/flow.py'),
        skillId: 'playwright-rpa-harden',
        collectionMode: 'diagnostic',
        eventVisibility: 'normal',
        businessContext: expect.objectContaining({
          stage: 'codegen-hardening',
          codegenSessionId: 'cg_abc123',
          flowId: 'case_query',
          inputFiles: ['input/flow.py'],
        }),
      }),
    );
    expect(JSON.stringify(daemon.createRun.mock.calls[0]?.[0])).not.toContain('"prompt"');
  });

  it('downloads required artifacts and writes a valid final flow', async () => {
    const { session, storageRoot, store, workflow } = await createHarness();

    await workflow.startHardening(session.sessionId);

    for (const name of requiredGenerationArtifactNames) {
      await expect(readFile(path.join(storageRoot, 'flows', 'case_query', name), 'utf8')).resolves.toContain(
        name === 'flow.dsl.json' ? '"flow_id": "case_query"' : '',
      );
    }
    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({ status: 'hardened' });
  });

  it('moves to needs_input on terminal question-form before validating artifacts', async () => {
    const questionForm = `<question-form id="rpa-parameterization" version="rpa-question-form.v0.1">
{
  "version": "rpa-question-form.v0.1",
  "title": "确认参数",
  "questions": [{"id":"date","type":"text","label":"日期"}]
}
</question-form>`;
    const { session, store, workflow } = await createHarness([
      { type: 'text_delta', delta: questionForm.slice(0, 55) },
      { type: 'text_delta', delta: questionForm.slice(55) },
      { type: 'end', status: 'succeeded' },
    ]);

    await workflow.startHardening(session.sessionId);

    const updated = await store.getSession(session.sessionId);
    expect(updated.status).toBe('needs_input');
    expect(updated.questionForm).toMatchObject({
      formId: 'rpa-parameterization',
      version: 'rpa-question-form.v0.1',
      questions: [{ id: 'date', type: 'text', label: '日期' }],
    });
  });

  it('creates a revise run when question-form answers are submitted', async () => {
    const questionForm = `<question-form id="rpa-parameterization" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[{"id":"date","type":"text","label":"日期"}]}
</question-form>`;
    const { daemon, session, store, workflow } = await createHarness([
      { type: 'text_delta', delta: questionForm },
      { type: 'end', status: 'succeeded' },
    ]);
    await workflow.startHardening(session.sessionId);
    daemon.events = successfulEvents();

    await workflow.submitQuestionAnswers(session.sessionId, {
      formId: 'rpa-parameterization',
      answers: { date: '2026-06-06' },
    });

    expect(daemon.createRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profileId: 'rpa-local',
        workspaceId: 'ws_1',
        conversationId: 'conv_1',
        kind: 'revise',
        promptMode: 'business-context',
        currentPrompt: expect.stringContaining('question-form'),
        skillId: 'playwright-rpa-harden',
        businessContext: expect.objectContaining({
          stage: 'codegen-hardening-follow-up',
          previousRunId: 'run_1',
          formAnswers: { date: '2026-06-06' },
        }),
      }),
    );
    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({ status: 'hardened' });
  });

  it('fails the session when artifacts are present but DSL is invalid', async () => {
    const { session, store, workflow } = await createHarness(successfulEvents({ invalidDsl: true }));

    await workflow.startHardening(session.sessionId);

    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'DSL_INVALID' },
    });
  });

  it('does not leave a final flow directory behind when DSL validation fails', async () => {
    const { session, storageRoot, workflow } = await createHarness(successfulEvents({ invalidDsl: true }));

    await workflow.startHardening(session.sessionId);

    await expect(readdir(path.join(storageRoot, 'flows', 'case_query'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails when daemon artifact download returns an error response', async () => {
    const { daemon, session, store, workflow } = await createHarness();
    daemon.downloadArtifact.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    await workflow.startHardening(session.sessionId);

    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'ARTIFACT_DOWNLOAD_FAILED' },
    });
  });

  it('fails the session when the daemon run ends failed', async () => {
    const { session, store, workflow } = await createHarness([{ type: 'end', status: 'failed' }]);

    await workflow.startHardening(session.sessionId);

    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'DAEMON_RUN_FAILED' },
    });
  });

  it('fails when required artifacts are missing and ignores non-output artifacts', async () => {
    const { daemon, session, store, workflow } = await createHarness();
    daemon.listRunArtifacts.mockResolvedValueOnce({
      artifacts: [
        ...requiredGenerationArtifactNames.slice(0, 4).map(artifact),
        { ...artifact('notes.txt'), id: 'art_notes', relativePath: 'work/notes.txt', fileName: 'notes.txt' },
      ],
    });

    await workflow.startHardening(session.sessionId);

    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'ARTIFACT_VALIDATION_FAILED' },
    });
    expect(daemon.downloadArtifact).not.toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'art_notes' }));
  });

  it('cancels active daemon runs during hardening', async () => {
    const { daemon, session, workflow } = await createHarness([
      { type: 'status', label: 'running' },
    ]);
    const running = workflow.startHardening(session.sessionId);
    await vi.waitFor(() => expect(daemon.createRun).toHaveBeenCalled());

    await workflow.cancel(session.sessionId);
    daemon.finishEvents();
    await running;

    expect(daemon.cancelRun).toHaveBeenCalledWith('run_1');
  });

  it('does not attach a daemon failure error to cancelled hardening sessions', async () => {
    const { daemon, session, store, workflow } = await createHarness([
      { type: 'status', label: 'running' },
    ]);
    const running = workflow.startHardening(session.sessionId);
    await vi.waitFor(() => expect(daemon.createRun).toHaveBeenCalled());

    await workflow.cancel(session.sessionId);
    daemon.finishEvents();
    await running;

    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'cancelled',
      error: null,
    });
  });

  it('supports a second question-form after answer submission', async () => {
    const firstForm = `<question-form id="qf_1" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[{"id":"date","type":"text","label":"日期"}]}
</question-form>`;
    const secondForm = `<question-form id="qf_2" version="rpa-question-form.v0.1">
{"version":"rpa-question-form.v0.1","questions":[{"id":"unit","type":"text","label":"单位"}]}
</question-form>`;
    const { daemon, session, store, workflow } = await createHarness([
      { type: 'text_delta', delta: firstForm },
      { type: 'end', status: 'succeeded' },
    ]);
    await workflow.startHardening(session.sessionId);
    daemon.events = [
      { type: 'text_delta', delta: secondForm },
      { type: 'end', status: 'succeeded' },
    ];

    await workflow.submitQuestionAnswers(session.sessionId, {
      formId: 'qf_1',
      answers: { date: '2026-06-06' },
    });

    await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'needs_input',
      questionForm: { formId: 'qf_2' },
    });
  });
});

function successfulEvents(options: { invalidDsl?: boolean } = {}): unknown[] {
  return [
    ...requiredGenerationArtifactNames.map((name) => ({
      type: 'artifact_finalized',
      artifact: artifact(name),
    })),
    { type: 'end', status: 'succeeded', invalidDsl: options.invalidDsl },
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

class FakeDaemonClient implements CodegenHardeningDaemonClient {
  events: unknown[];
  private pendingController?: ReadableStreamDefaultController<unknown>;

  readonly createWorkspace = vi.fn(
    async (_request: CreateWorkspaceRequest): Promise<PublicWorkspace> => ({
      workspaceId: 'ws_1',
      workspaceKey: 'rpa/local/codegen',
    }),
  );

  readonly uploadWorkspaceFile = vi.fn(async () => ({
    workspaceId: 'ws_1',
    workspaceKey: 'rpa/local/codegen',
    file: {
      targetPath: 'input/flow.py',
      size: 12,
      originalName: 'flow.py',
      mimeType: 'text/x-python',
    },
  }));

  readonly createRun = vi.fn(
    async (_request: CreateRunRequest): Promise<CreateRunResponse> => ({
      runId: 'run_1',
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
      artifactId.includes('invalid')
        ? JSON.stringify({ invalid: true }, null, 2)
        : fileName === 'flow.dsl.json'
        ? JSON.stringify(
            {
              ...createMinimalRpaDsl(),
              flow_id: 'case_query',
            },
            null,
            2,
          )
        : `${fileName}\n`;
    return new Response(body);
  });

  readonly cancelRun = vi.fn(async () => ({ ok: true as const }));

  constructor(events: unknown[]) {
    this.events = events;
    if (events.some((event) => isRecord(event) && event.type === 'end' && event.invalidDsl === true)) {
      this.listRunArtifacts = vi.fn(async (): Promise<ArtifactsResponse> => ({
        artifacts: requiredGenerationArtifactNames.map((name) =>
          name === 'flow.dsl.json' ? { ...artifact(name), id: 'art_invalid_flow.dsl.json' } : artifact(name),
        ),
      }));
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

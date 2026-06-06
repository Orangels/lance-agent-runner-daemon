import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerNaturalLanguageRoutes } from '../../../src/server/routes/natural-language.js';
import type { NaturalLanguageSessionStore } from '../../../src/server/natural-language/nl-session-store.js';
import type { NaturalLanguageSessionRecord } from '../../../src/server/natural-language/nl-session-store.js';
import type { NaturalLanguageGenerationWorkflow } from '../../../src/server/workflows/natural-language-generation-workflow.js';
import type {
  NaturalLanguageSessionStatusResponse,
  StartNaturalLanguageSessionRequest,
} from '../../../src/shared/natural-language-types.js';

describe('natural-language RPA routes', () => {
  const servers: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it('starts generation in the background and returns 202 without awaiting Claude Code', async () => {
    const harness = createHarness();
    const baseUrl = await listen(harness.app, servers);

    const response = await fetch(`${baseUrl}/api/rpa/nl/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: 'https://example.com/cases',
        flowId: 'case_query',
        flowName: 'Case query',
        requirement: 'Open the cases page and search by case number.',
        businessConstraints: 'No login and no writes.',
        safetyNotes: 'Ask before any submit action.',
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: 'nl_abc123',
      flowId: 'case_query',
      status: 'starting',
      targetUrl: 'https://example.com/cases',
    });
    expect(harness.store.createSession).toHaveBeenCalledWith({
      targetUrl: 'https://example.com/cases',
      flowId: 'case_query',
      flowName: 'Case query',
      requirement: 'Open the cases page and search by case number.',
      businessConstraints: 'No login and no writes.',
      safetyNotes: 'Ask before any submit action.',
    });
    expect(harness.workflow.startGeneration).toHaveBeenCalledWith('nl_abc123');
  });

  it('returns 202 even when startGeneration is still pending', async () => {
    let resolveGeneration!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveGeneration = resolve;
    });
    const harness = createHarness({
      workflow: { startGeneration: vi.fn(() => pending) },
    });
    const baseUrl = await listen(harness.app, servers);

    const response = await fetch(`${baseUrl}/api/rpa/nl/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: 'https://example.com/cases',
        flowId: 'case_query',
        requirement: 'Search cases.',
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: 'starting' });
    resolveGeneration();
    await pending;
  });

  it('returns public session status', async () => {
    const harness = createHarness();
    const baseUrl = await listen(harness.app, servers);

    const response = await fetch(`${baseUrl}/api/rpa/nl/sessions/nl_abc123`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: 'nl_abc123',
      flowId: 'case_query',
      status: 'starting',
    });
    expect(harness.store.getPublicSession).toHaveBeenCalledWith('nl_abc123');
  });

  it('submits question-form answers in the background', async () => {
    const harness = createHarness();
    const baseUrl = await listen(harness.app, servers);

    const response = await fetch(`${baseUrl}/api/rpa/nl/sessions/nl_abc123/question-form/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        formId: 'qf_1',
        answers: { date: '2026-06-06' },
      }),
    });

    expect(response.status).toBe(202);
    expect(harness.workflow.submitQuestionAnswers).toHaveBeenCalledWith('nl_abc123', {
      formId: 'qf_1',
      answers: { date: '2026-06-06' },
    });
  });

  it('starts repair in the background', async () => {
    const harness = createHarness();
    const baseUrl = await listen(harness.app, servers);

    const response = await fetch(`${baseUrl}/api/rpa/nl/sessions/nl_abc123/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executionId: 'exec_1',
        instruction: 'Fix the failed search button selector.',
      }),
    });

    expect(response.status).toBe(202);
    expect(harness.workflow.repairFromExecutionFailure).toHaveBeenCalledWith('nl_abc123', {
      executionId: 'exec_1',
      instruction: 'Fix the failed search button selector.',
    });
  });

  it('cancels generation workflow', async () => {
    const harness = createHarness();
    const baseUrl = await listen(harness.app, servers);

    const response = await fetch(`${baseUrl}/api/rpa/nl/sessions/nl_abc123/cancel`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(harness.workflow.cancel).toHaveBeenCalledWith('nl_abc123');
    await expect(response.json()).resolves.toMatchObject({ sessionId: 'nl_abc123' });
  });

  it('validates input and redacts storageRoot in errors', async () => {
    const harness = createHarness({
      store: {
        createSession: vi.fn(async () => {
          throw Object.assign(new Error('/tmp/rpa-secret-path failed'), { code: 'BOOM' });
        }),
      },
      storageRoot: '/tmp/rpa-secret-path',
    });
    const baseUrl = await listen(harness.app, servers);

    const invalid = await fetch(`${baseUrl}/api/rpa/nl/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'file:///etc/passwd', flowId: 'bad-flow', requirement: '' }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });

    const error = await fetch(`${baseUrl}/api/rpa/nl/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: 'https://example.com/cases',
        flowId: 'case_query',
        requirement: 'Search cases.',
      }),
    });
    expect(error.status).toBe(500);
    const payload = await error.json();
    expect(payload.error.message).toContain('[rpa-storage]');
    expect(JSON.stringify(payload)).not.toContain('/tmp/rpa-secret-path');
  });
});

async function listen(app: express.Express, servers: Array<{ close: () => void }>): Promise<string> {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const nextServer = app.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function createHarness(overrides: {
  storageRoot?: string;
  store?: Partial<NaturalLanguageSessionStore>;
  workflow?: Partial<NaturalLanguageGenerationWorkflow>;
} = {}) {
  const app = express();
  app.use(express.json());

  const session = createSession();
  const store = {
    createSession: vi.fn(async (_input: StartNaturalLanguageSessionRequest) => session),
    getSession: vi.fn(async () => session),
    getPublicSession: vi.fn(async () => toPublicSession(session)),
    transition: vi.fn(async () => session),
    setDaemonRun: vi.fn(async () => session),
    setQuestionForm: vi.fn(async () => session),
    setArtifacts: vi.fn(async () => session),
    appendLog: vi.fn(async () => session),
    setError: vi.fn(async () => session),
    ...overrides.store,
  } satisfies NaturalLanguageSessionStore;
  const workflow = {
    startGeneration: vi.fn(async () => undefined),
    submitQuestionAnswers: vi.fn(async () => undefined),
    repairFromExecutionFailure: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    ...overrides.workflow,
  } satisfies NaturalLanguageGenerationWorkflow;

  registerNaturalLanguageRoutes(app, {
    storageRoot: overrides.storageRoot ?? '/tmp/rpa-storage',
    store,
    workflow,
  });

  return { app, store, workflow };
}

function createSession(): NaturalLanguageSessionRecord {
  return {
    sessionId: 'nl_abc123',
    flowId: 'case_query',
    flowName: 'Case query',
    targetUrl: 'https://example.com/cases',
    requirement: 'Search cases.',
    businessConstraints: 'No login.',
    safetyNotes: 'No writes.',
    status: 'starting',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    finalFlowDir: '/tmp/rpa-storage/flows/case_query',
    questionForm: null,
    artifacts: [],
    logs: [],
    error: null,
  };
}

function toPublicSession(session: NaturalLanguageSessionRecord): NaturalLanguageSessionStatusResponse {
  return {
    sessionId: session.sessionId,
    flowId: session.flowId,
    flowName: session.flowName,
    targetUrl: session.targetUrl,
    requirement: session.requirement,
    status: session.status,
    workspaceId: session.workspaceId,
    daemonRunId: session.daemonRunId,
    conversationId: session.conversationId,
    questionForm: session.questionForm,
    artifacts: session.artifacts,
    logs: session.logs,
    error: session.error,
  };
}

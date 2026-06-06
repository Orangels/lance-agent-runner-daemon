import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createNaturalLanguageSessionStore,
  resolveNaturalLanguageSessionDir,
  safeNaturalLanguageSessionId,
} from '../../src/server/natural-language/nl-session-store.js';

function sequentialIds(ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? 'nl_extra';
}

async function createTempStore(options: { ids?: string[]; maxLogs?: number } = {}) {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-nl-store-'));
  const store = createNaturalLanguageSessionStore({
    storageRoot,
    idFactory: sequentialIds(options.ids ?? ['nl_abc123']),
    maxLogs: options.maxLogs,
  });
  return { storageRoot, store };
}

describe('natural-language session store', () => {
  it('creates sessions with safe ids, empty session directories, and final flow dirs', async () => {
    const { storageRoot, store } = await createTempStore();

    const session = await store.createSession({
      flowId: 'case_query',
      flowName: '案件查询',
      targetUrl: 'https://example.com/cases',
      requirement: '按案件号查询。',
      businessConstraints: '不登录。',
      safetyNotes: '不提交。',
    });

    expect(safeNaturalLanguageSessionId('nl_abc123')).toBe('nl_abc123');
    expect(resolveNaturalLanguageSessionDir(storageRoot, 'nl_abc123')).toBe(
      path.join(path.resolve(storageRoot), 'nl-sessions', 'nl_abc123'),
    );
    expect(session).toMatchObject({
      sessionId: 'nl_abc123',
      flowId: 'case_query',
      flowName: '案件查询',
      targetUrl: 'https://example.com/cases',
      requirement: '按案件号查询。',
      businessConstraints: '不登录。',
      safetyNotes: '不提交。',
      status: 'starting',
      finalFlowDir: path.join(path.resolve(storageRoot), 'flows', 'case_query'),
      questionForm: null,
      artifacts: [],
      error: null,
    });
    await expect(readdir(path.join(storageRoot, 'nl-sessions', 'nl_abc123'))).resolves.toEqual([]);
  });

  it('returns sanitized public sessions with daemon metadata, forms, artifacts, errors, and truncated logs', async () => {
    const { storageRoot, store } = await createTempStore({ maxLogs: 2 });
    const session = await store.createSession({
      flowId: 'case_query',
      flowName: 'Case query',
      targetUrl: 'https://example.com/cases',
      requirement: 'Generate a query flow.',
    });

    await store.transition(session.sessionId, 'generating');
    await store.setDaemonRun(session.sessionId, {
      workspaceId: 'ws_1',
      daemonRunId: 'run_1',
      conversationId: 'conv_1',
    });
    await store.setQuestionForm(session.sessionId, {
      formId: 'qf_1',
      version: 'rpa-question-form.v0.1',
      questions: [
        {
          id: 'caseNo',
          type: 'text',
          label: '案件号',
          description: `source ${path.join(storageRoot, 'nl-sessions', session.sessionId)}`,
        },
      ],
    });
    await store.setArtifacts(session.sessionId, [
      {
        artifactId: 'art_flow',
        fileName: 'flow.dsl.json',
        relativePath: path.join(storageRoot, 'flows', 'case_query', 'flow.dsl.json'),
        size: 120,
      },
    ]);
    await store.appendLog(session.sessionId, 'first log');
    await store.appendLog(session.sessionId, `second log ${path.join(storageRoot, 'nl-sessions', session.sessionId)}`);
    await store.appendLog(session.sessionId, `third log ${path.join(storageRoot, 'flows', 'case_query')}`);
    await store.setError(session.sessionId, {
      code: 'NL_GENERATION_FAILED',
      message: `failed near ${path.join(storageRoot, 'nl-sessions', session.sessionId)}`,
    });

    const summary = await store.getPublicSession(session.sessionId);

    expect(summary).toMatchObject({
      sessionId: 'nl_abc123',
      flowId: 'case_query',
      flowName: 'Case query',
      status: 'generating',
      targetUrl: 'https://example.com/cases',
      requirement: 'Generate a query flow.',
      workspaceId: 'ws_1',
      daemonRunId: 'run_1',
      conversationId: 'conv_1',
      questionForm: {
        formId: 'qf_1',
        questions: [
          {
            id: 'caseNo',
            type: 'text',
            label: '案件号',
            description: 'source [rpa-storage]/nl-sessions/nl_abc123',
          },
        ],
      },
      artifacts: [
        {
          artifactId: 'art_flow',
          fileName: 'flow.dsl.json',
          relativePath: '[rpa-storage]/flows/case_query/flow.dsl.json',
          size: 120,
        },
      ],
      logs: ['second log [rpa-storage]/nl-sessions/nl_abc123', 'third log [rpa-storage]/flows/case_query'],
      error: {
        code: 'NL_GENERATION_FAILED',
        message: 'failed near [rpa-storage]/nl-sessions/nl_abc123',
      },
    });
    expect(JSON.stringify(summary)).not.toContain(storageRoot);
    expect(summary).not.toHaveProperty('finalFlowDir');
  });

  it('rejects unsafe session ids, unsafe flow ids, duplicate sessions, and unknown sessions', async () => {
    const { storageRoot, store } = await createTempStore({ ids: ['nl_before_bad_flow', 'nl_abc123', 'nl_abc123'] });

    expect(() => safeNaturalLanguageSessionId('../nl_bad')).toThrow(/Invalid natural-language session id/);
    expect(() => safeNaturalLanguageSessionId('nl_')).toThrow(/Invalid natural-language session id/);
    expect(() => resolveNaturalLanguageSessionDir(storageRoot, '../nl_bad')).toThrow(
      /Invalid natural-language session id/,
    );

    await expect(
      store.createSession({
        flowId: '../bad',
        targetUrl: 'https://example.com',
        requirement: 'x',
      }),
    ).rejects.toThrow(/invalid flow id/i);

    await store.createSession({ flowId: 'case_query', targetUrl: 'https://example.com', requirement: 'x' });
    await expect(
      store.createSession({ flowId: 'case_query_2', targetUrl: 'https://example.com', requirement: 'x' }),
    ).rejects.toThrow(/already exists/i);
    await expect(store.getSession('nl_missing')).rejects.toThrow(/Unknown natural-language session/);
  });

  it('rejects sessions that would overwrite an existing final flow', async () => {
    const { storageRoot, store } = await createTempStore();
    await mkdir(path.join(storageRoot, 'flows', 'case_query'), { recursive: true });
    await writeFile(path.join(storageRoot, 'flows', 'case_query', 'flow.dsl.json'), '{}\n');

    await expect(
      store.createSession({
        flowId: 'case_query',
        targetUrl: 'https://example.com',
        requirement: 'x',
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('enforces planned status transitions and keeps terminal statuses terminal', async () => {
    const { store } = await createTempStore({ ids: ['nl_abc123', 'nl_needs_failed', 'nl_generated_failed', 'nl_failed'] });
    const session = await store.createSession({
      flowId: 'case_query',
      targetUrl: 'https://example.com',
      requirement: 'x',
    });

    await expect(store.transition(session.sessionId, 'generated')).rejects.toThrow(/Illegal/i);

    await store.transition(session.sessionId, 'generating');
    await store.transition(session.sessionId, 'needs_input');
    await store.transition(session.sessionId, 'generating');
    await store.transition(session.sessionId, 'generated');
    await expect(store.transition(session.sessionId, 'generated')).resolves.toMatchObject({ status: 'generated' });
    await store.transition(session.sessionId, 'repairing');
    await store.transition(session.sessionId, 'needs_input');
    await store.transition(session.sessionId, 'cancelled');
    await expect(store.transition(session.sessionId, 'generating')).rejects.toThrow(/Illegal/i);

    const needsInputFailure = await store.createSession({
      flowId: 'case_query_2',
      targetUrl: 'https://example.com',
      requirement: 'x',
    });
    await store.transition(needsInputFailure.sessionId, 'generating');
    await store.transition(needsInputFailure.sessionId, 'needs_input');
    await expect(store.transition(needsInputFailure.sessionId, 'failed')).resolves.toMatchObject({ status: 'failed' });
    await expect(store.transition(needsInputFailure.sessionId, 'generating')).rejects.toThrow(/Illegal/i);

    const generatedFailure = await store.createSession({
      flowId: 'case_query_3',
      targetUrl: 'https://example.com',
      requirement: 'x',
    });
    await store.transition(generatedFailure.sessionId, 'generating');
    await store.transition(generatedFailure.sessionId, 'generated');
    await expect(store.transition(generatedFailure.sessionId, 'failed')).resolves.toMatchObject({ status: 'failed' });
    await expect(store.transition(generatedFailure.sessionId, 'repairing')).rejects.toThrow(/Illegal/i);

    const failed = await store.createSession({
      flowId: 'case_query_4',
      targetUrl: 'https://example.com',
      requirement: 'x',
    });
    await store.transition(failed.sessionId, 'failed');
    await expect(store.transition(failed.sessionId, 'generating')).rejects.toThrow(/Illegal/i);
  });
});

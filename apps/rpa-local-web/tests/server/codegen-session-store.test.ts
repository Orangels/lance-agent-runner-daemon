import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCodegenSessionStore,
  resolveCodegenInputScriptPath,
  resolveCodegenSessionInputDir,
  safeCodegenSessionId,
} from '../../src/server/codegen/codegen-session-store.js';
import { resolveFlowDir } from '../../src/server/flow-store.js';

async function createTempStore(idFactory = () => 'cg_abc123') {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-codegen-store-'));
  const store = createCodegenSessionStore({ storageRoot, idFactory });
  return { storageRoot, store };
}

describe('RPA codegen session store', () => {
  it('accepts safe flow and session ids and resolves confined session paths', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-codegen-paths-'));

    expect(safeCodegenSessionId('cg_abc123')).toBe('cg_abc123');
    expect(resolveCodegenSessionInputDir(storageRoot, 'cg_abc123')).toBe(
      path.join(path.resolve(storageRoot), 'codegen-sessions', 'cg_abc123', 'input'),
    );
    expect(resolveCodegenInputScriptPath(storageRoot, 'cg_abc123')).toBe(
      path.join(path.resolve(storageRoot), 'codegen-sessions', 'cg_abc123', 'input', 'flow.py'),
    );
    expect(resolveFlowDir(storageRoot, 'case_query')).toBe(
      path.join(path.resolve(storageRoot), 'flows', 'case_query'),
    );
  });

  it('rejects unsafe ids and path traversal attempts', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-codegen-unsafe-'));

    expect(() => safeCodegenSessionId('../cg_bad')).toThrow(/Invalid codegen session id/);
    expect(() => safeCodegenSessionId('cg_')).toThrow(/Invalid codegen session id/);
    expect(() => resolveCodegenInputScriptPath(storageRoot, '../cg_bad')).toThrow(/Invalid codegen session id/);
    expect(() => resolveFlowDir(storageRoot, '../flow')).toThrow(/Invalid flow id/);
  });

  it('creates a public session summary without leaking absolute paths', async () => {
    const { storageRoot, store } = await createTempStore();

    const session = await store.createSession({
      flowId: 'case_query',
      flowName: 'Case query',
      targetUrl: 'https://example.com/cases',
    });
    await store.setRecording(session.sessionId);
    await store.setDaemonRun(session.sessionId, {
      workspaceId: 'ws_1',
      daemonRunId: 'run_1',
      conversationId: 'conv_1',
    });
    await store.appendLog(session.sessionId, `recorded ${storageRoot}/codegen-sessions/${session.sessionId}/input/flow.py`);
    await store.setQuestionForm(session.sessionId, { formId: 'qf_1', questions: [] });
    await store.setArtifacts(session.sessionId, [
      {
        artifactId: 'art_flow',
        relativePath: 'output/flow.dsl.json',
        fileName: 'flow.dsl.json',
        size: 120,
      },
    ]);
    await store.setError(session.sessionId, {
      code: 'CODEGEN_FAILED',
      message: `failed near ${path.join(storageRoot, 'codegen-sessions', session.sessionId, 'input', 'flow.py')}`,
    });

    const summary = await store.getPublicSession(session.sessionId);

    expect(summary).toMatchObject({
      sessionId: 'cg_abc123',
      flowId: 'case_query',
      flowName: 'Case query',
      targetUrl: 'https://example.com/cases',
      status: 'recording',
      recording: { inputPath: 'input/flow.py' },
      workspaceId: 'ws_1',
      daemonRunId: 'run_1',
      conversationId: 'conv_1',
      questionForm: { formId: 'qf_1', questions: [] },
      artifacts: [
        {
          artifactId: 'art_flow',
          relativePath: 'output/flow.dsl.json',
          fileName: 'flow.dsl.json',
          size: 120,
        },
      ],
      error: {
        code: 'CODEGEN_FAILED',
        message: 'failed near [rpa-storage]/codegen-sessions/cg_abc123/input/flow.py',
      },
    });
    expect(JSON.stringify(summary)).not.toContain(storageRoot);
    expect(summary.logs[0]).toContain('[rpa-storage]/codegen-sessions');
  });

  it('rejects illegal status transitions', async () => {
    const { store } = await createTempStore();
    const session = await store.createSession({
      flowId: 'case_query',
      flowName: 'Case query',
      targetUrl: 'https://example.com',
    });

    await expect(store.transition(session.sessionId, 'hardening')).rejects.toThrow(/Illegal codegen session status transition/);

    await store.setRecording(session.sessionId);
    await store.transition(session.sessionId, 'completed');
    await store.transition(session.sessionId, 'hardening');
    await store.transition(session.sessionId, 'needs_input');
    await store.transition(session.sessionId, 'hardening');
    await store.transition(session.sessionId, 'hardened');
    await expect(store.transition(session.sessionId, 'hardened')).resolves.toMatchObject({ status: 'hardened' });
    await expect(store.transition(session.sessionId, 'cancelled')).rejects.toThrow(
      /Illegal codegen session status transition/,
    );
  });

  it('rejects a new session when final flow artifacts already exist for the flow id', async () => {
    const { storageRoot, store } = await createTempStore(() => 'cg_first');
    const finalDir = resolveFlowDir(storageRoot, 'case_query');
    await mkdir(finalDir, { recursive: true });
    await writeFile(path.join(finalDir, 'flow.dsl.json'), '{}\n', 'utf8');

    await expect(
      store.createSession({
        flowId: 'case_query',
        flowName: 'Case query',
        targetUrl: 'https://example.com',
      }),
    ).rejects.toThrow(/already exists/);
  });
});

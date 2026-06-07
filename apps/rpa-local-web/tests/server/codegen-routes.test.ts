import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRpaLocalServer } from '../../src/server/server.js';
import type { CodegenHardeningWorkflow } from '../../src/server/workflows/codegen-hardening-workflow.js';

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function withCodegenServer(
  options: {
    storageRoot: string;
    runnerPath: string;
    workflow?: CodegenHardeningWorkflow;
  },
  callback: (baseUrl: string) => Promise<void>,
) {
  const app = await createRpaLocalServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      daemonBaseUrl: 'http://daemon.local',
      daemonApiKey: 'secret',
      defaultProfileId: 'rpa-local',
      storageRoot: options.storageRoot,
      codegenCommand: process.execPath,
      codegenArgs: [options.runnerPath],
      mode: 'test',
    },
    daemonFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    codegenWorkflow: options.workflow,
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback(`http://127.0.0.1:${port}`);
}

describe('RPA codegen routes', () => {
  it('starts a codegen session, records flow.py, and waits for a hardening requirement', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-codegen-routes-'));
    const runnerPath = await createFakeCodegen(storageRoot, 'success');
    const workflow = fakeWorkflow();

    await withCodegenServer({ storageRoot, runnerPath, workflow }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rpa/codegen/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: 'https://example.com/start',
          flowId: 'case_query',
          flowName: 'Case query',
        }),
      });

      expect(response.status).toBe(202);
      const payload = await response.json();
      expect(payload).toMatchObject({
        flowId: 'case_query',
        status: 'recording',
        recording: { inputPath: 'input/flow.py' },
      });
      expect(JSON.stringify(payload)).not.toContain(storageRoot);

      await vi.waitFor(async () => {
        const status = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${payload.sessionId}`).then((res) => res.json());
        expect(status.status).toBe('completed');
      });
      expect(workflow.startHardening).not.toHaveBeenCalled();
      const status = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${payload.sessionId}`).then((res) => res.json());
      expect(JSON.stringify(status)).not.toContain(storageRoot);
    });
  });

  it('requires a post-recording requirement before triggering hardening', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-codegen-routes-harden-'));
    const runnerPath = await createFakeCodegen(storageRoot, 'success');
    const workflow = fakeWorkflow();

    await withCodegenServer({ storageRoot, runnerPath, workflow }, async (baseUrl) => {
      const started = await fetch(`${baseUrl}/api/rpa/codegen/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: 'https://example.com/start',
          flowId: 'case_query',
          flowName: 'Case query',
        }),
      }).then((res) => res.json());

      await vi.waitFor(async () => {
        const status = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${started.sessionId}`).then((res) => res.json());
        expect(status.status).toBe('completed');
      });

      const missingRequirement = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${started.sessionId}/harden`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirement: '   ' }),
      });
      expect(missingRequirement.status).toBe(400);

      const response = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${started.sessionId}/harden`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirement: '查询北京天气并保存为 JSON。',
        }),
      });

      expect(response.status).toBe(202);
      expect(workflow.startHardening).toHaveBeenCalledWith(started.sessionId);
      const hardening = await response.json();
      expect(hardening).toMatchObject({
        status: 'hardening',
        requirement: '查询北京天气并保存为 JSON。',
      });
    });
  });

  it('rejects hardening before recording completes', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-codegen-routes-early-harden-'));
    const runnerPath = await createFakeCodegen(storageRoot, 'sleep');
    const workflow = fakeWorkflow();

    await withCodegenServer({ storageRoot, runnerPath, workflow }, async (baseUrl) => {
      const started = await fetch(`${baseUrl}/api/rpa/codegen/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: 'https://example.com/start',
          flowId: 'case_query',
          flowName: 'Case query',
        }),
      }).then((res) => res.json());

      const response = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${started.sessionId}/harden`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirement: '查询北京天气并保存为 JSON。' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'SESSION_NOT_READY' } });
      expect(workflow.startHardening).not.toHaveBeenCalled();
    });
  });

  it('rejects repeated hardening submissions without failing the active session', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-codegen-routes-repeat-harden-'));
    const runnerPath = await createFakeCodegen(storageRoot, 'success');
    const workflow = fakeWorkflow({
      startHardening: vi.fn(async () => {
        await new Promise(() => undefined);
      }),
    });

    await withCodegenServer({ storageRoot, runnerPath, workflow }, async (baseUrl) => {
      const started = await fetch(`${baseUrl}/api/rpa/codegen/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: 'https://example.com/start',
          flowId: 'case_query',
          flowName: 'Case query',
        }),
      }).then((res) => res.json());

      await vi.waitFor(async () => {
        const status = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${started.sessionId}`).then((res) => res.json());
        expect(status.status).toBe('completed');
      });

      const first = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${started.sessionId}/harden`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirement: '查询北京天气并保存为 JSON。' }),
      });
      expect(first.status).toBe(202);

      const second = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${started.sessionId}/harden`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirement: '重复提交。' }),
      });
      expect(second.status).toBe(400);
      await expect(second.json()).resolves.toMatchObject({ error: { code: 'SESSION_NOT_READY' } });
      expect(workflow.startHardening).toHaveBeenCalledTimes(1);

      const status = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${started.sessionId}`).then((res) => res.json());
      expect(status).toMatchObject({
        status: 'hardening',
        error: null,
        requirement: '查询北京天气并保存为 JSON。',
      });
    });
  });

  it('returns structured validation errors and rejects existing final flows by default', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-codegen-routes-invalid-'));
    const runnerPath = await createFakeCodegen(storageRoot, 'success');
    await mkdir(path.join(storageRoot, 'flows', 'case_query'), { recursive: true });
    await writeFile(path.join(storageRoot, 'flows', 'case_query', 'flow.dsl.json'), '{}\n');

    await withCodegenServer({ storageRoot, runnerPath, workflow: fakeWorkflow() }, async (baseUrl) => {
      const invalid = await fetch(`${baseUrl}/api/rpa/codegen/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: 'file:///etc/passwd', flowId: 'bad-flow' }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });

      const existing = await fetch(`${baseUrl}/api/rpa/codegen/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: 'https://example.com', flowId: 'case_query' }),
      });
      expect(existing.status).toBe(409);
      await expect(existing.json()).resolves.toMatchObject({ error: { code: 'FLOW_ALREADY_EXISTS' } });
    });
  });

  it('cancels sessions and submits question-form answers', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-codegen-routes-answers-'));
    const runnerPath = await createFakeCodegen(storageRoot, 'sleep');
    const workflow = fakeWorkflow();

    await withCodegenServer({ storageRoot, runnerPath, workflow }, async (baseUrl) => {
      const started = await fetch(`${baseUrl}/api/rpa/codegen/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: 'https://example.com', flowId: 'case_query' }),
      }).then((res) => res.json());

      const cancel = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${started.sessionId}/cancel`, { method: 'POST' });
      expect(cancel.status).toBe(200);
      await expect(cancel.json()).resolves.toMatchObject({ status: 'cancelled' });

      const answers = await fetch(`${baseUrl}/api/rpa/codegen/sessions/${started.sessionId}/question-form/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formId: 'qf_1', answers: { date: '2026-06-06' } }),
      });
      expect(answers.status).toBe(202);
      expect(workflow.submitQuestionAnswers).toHaveBeenCalledWith(started.sessionId, {
        formId: 'qf_1',
        answers: { date: '2026-06-06' },
      });
    });
  });
});

function fakeWorkflow(overrides: Partial<CodegenHardeningWorkflow> = {}): CodegenHardeningWorkflow {
  return {
    startHardening: vi.fn(async () => undefined),
    submitQuestionAnswers: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function createFakeCodegen(storageRoot: string, behavior: 'success' | 'sleep') {
  const runnerPath = path.join(storageRoot, `fake-codegen-${behavior}.mjs`);
  const source = `
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const outputPath = args[args.indexOf('-o') + 1];
if ('${behavior}' === 'sleep') {
  process.on('SIGTERM', () => process.exit(0));
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, '# recorded flow\\n');
`;
  await writeFile(runnerPath, source);
  return runnerPath;
}

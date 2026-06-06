import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { createRpaLocalServer } from '../../../src/server/server.js';

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function withRpaServer(
  storageRoot: string,
  runnerPath: string,
  callback: (baseUrl: string) => Promise<void>,
) {
  const app = await createRpaLocalServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      daemonBaseUrl: 'http://daemon.local',
      daemonApiKey: 'secret',
      defaultProfileId: 'rpa-local',
      storageRoot,
      codegenCommand: 'playwright',
      codegenArgs: ['codegen'],
      mode: 'test',
    },
    daemonFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    executorOptions: {
      pythonCommand: process.execPath,
      pythonArgs: [runnerPath],
      defaultTimeoutMs: 5_000,
    },
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback(`http://127.0.0.1:${port}`);
}

async function createFlow(storageRoot: string, flowId = 'case_query') {
  const flowDir = path.join(storageRoot, 'flows', flowId);
  await mkdir(flowDir, { recursive: true });
  for (const name of requiredGenerationArtifactNames) {
    if (name === 'flow.dsl.json') {
      await writeFile(path.join(flowDir, name), `${JSON.stringify(createMinimalRpaDsl(), null, 2)}\n`);
    } else if (name === 'flow.hardened.py') {
      await writeFile(path.join(flowDir, name), '# generated script\n');
    } else {
      await writeFile(path.join(flowDir, name), `${name}\n`);
    }
  }
}

async function createFakeRunner(storageRoot: string, behavior: 'success' | 'sleep') {
  const runnerPath = path.join(storageRoot, `fake-${behavior}.mjs`);
  const source = `
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const executionDir = args[args.indexOf('--execution-dir') + 1];
console.log('script ' + args[0]);
console.error('stderr ' + executionDir);

if ('${behavior}' === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

await mkdir(path.join(executionDir, 'artifacts', 'screenshots'), { recursive: true });
await writeFile(path.join(executionDir, 'artifacts', 'screenshots', 'open_query.png'), 'fake screenshot');
console.log('done');
`;
  await writeFile(runnerPath, source);
  return runnerPath;
}

async function startExecution(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/rpa/executions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      flowId: 'case_query',
      daemonRunId: 'run_1',
      mode: 'verify',
      dryRun: true,
      headless: false,
      params: { case_no: 'A123' },
    }),
  });
  expect(response.status).toBe(202);
  return (await response.json()) as { executionId: string };
}

async function readSse(baseUrl: string, executionId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/rpa/executions/${executionId}/events`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  return response.text();
}

describe('RPA execution routes', () => {
  it('starts verify, replays SSE events, exposes safe status/logs/artifacts, and downloads screenshots', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-routes-success-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'success');

    await withRpaServer(storageRoot, runnerPath, async (baseUrl) => {
      const { executionId } = await startExecution(baseUrl);
      const eventText = await readSse(baseUrl, executionId);
      expect(eventText).toContain('event: run.started');
      expect(eventText).toContain('event: log');
      expect(eventText).toContain('event: artifact.created');
      expect(eventText).toContain('event: run.completed');
      expect(eventText).not.toContain(storageRoot);

      const status = await fetch(`${baseUrl}/api/rpa/executions/${executionId}`).then((res) => res.json());
      expect(status).toMatchObject({ executionId, status: 'succeeded', flowId: 'case_query' });
      expect(JSON.stringify(status)).not.toContain(storageRoot);

      const logs = await fetch(`${baseUrl}/api/rpa/executions/${executionId}/logs`).then((res) => res.json());
      expect(logs.stdout).toContain('[rpa-storage]/flows/case_query/flow.hardened.py');
      expect(logs.stderr).toContain('[rpa-storage]');
      expect(JSON.stringify(logs)).not.toContain(storageRoot);

      const artifacts = await fetch(`${baseUrl}/api/rpa/executions/${executionId}/artifacts`).then((res) => res.json());
      expect(artifacts.artifacts).toEqual([
        expect.objectContaining({ role: 'screenshot', fileName: 'open_query.png' }),
      ]);
      expect(JSON.stringify(artifacts)).not.toContain(storageRoot);

      const artifactId = artifacts.artifacts[0].artifactId;
      const screenshot = await fetch(`${baseUrl}/api/rpa/executions/${executionId}/screenshots/current`);
      expect(screenshot.status).toBe(200);
      expect(await screenshot.text()).toBe('fake screenshot');

      const download = await fetch(`${baseUrl}/api/rpa/executions/${executionId}/artifacts/${artifactId}/download`);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('fake screenshot');
    });
  });

  it('cancels a running execution', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-routes-cancel-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'sleep');

    await withRpaServer(storageRoot, runnerPath, async (baseUrl) => {
      const { executionId } = await startExecution(baseUrl);
      const cancel = await fetch(`${baseUrl}/api/rpa/executions/${executionId}/cancel`, { method: 'POST' });
      expect(cancel.status).toBe(200);
      const eventText = await readSse(baseUrl, executionId);
      expect(eventText).toContain('"status":"canceled"');
    });
  });

  it('streams a terminal event that is appended after the subscriber connects', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-routes-live-terminal-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'sleep');

    await withRpaServer(storageRoot, runnerPath, async (baseUrl) => {
      const { executionId } = await startExecution(baseUrl);
      const eventTextPromise = readSse(baseUrl, executionId);
      await waitForStatus(baseUrl, executionId, 'running');

      const cancel = await fetch(`${baseUrl}/api/rpa/executions/${executionId}/cancel`, { method: 'POST' });
      expect(cancel.status).toBe(200);

      const eventText = await eventTextPromise;
      expect(eventText).toContain('event: run.started');
      expect(eventText).toContain('event: run.completed');
      expect(eventText).toContain('"status":"canceled"');
    });
  });

  it('returns structured errors for unknown executions and unsafe artifact ids', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-routes-errors-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'success');

    await withRpaServer(storageRoot, runnerPath, async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/rpa/executions/exec_missing`).then((res) => res.json());
      expect(missing).toMatchObject({ error: { code: 'EXECUTION_NOT_FOUND' } });
      expect(JSON.stringify(missing)).not.toContain(storageRoot);

      const { executionId } = await startExecution(baseUrl);
      await readSse(baseUrl, executionId);
      const unsafe = await fetch(`${baseUrl}/api/rpa/executions/${executionId}/artifacts/../secret/download`);
      expect(unsafe.status).toBe(404);
      expect(await unsafe.text()).not.toContain(storageRoot);
    });
  });

  it('fails start validation before spawn when flow artifacts are missing', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-routes-missing-'));
    await mkdir(path.join(storageRoot, 'flows', 'case_query'), { recursive: true });
    const runnerPath = await createFakeRunner(storageRoot, 'success');

    await withRpaServer(storageRoot, runnerPath, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rpa/executions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowId: 'case_query', mode: 'verify', params: {} }),
      });
      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload).toMatchObject({ error: { code: 'FLOW_ARTIFACT_MISSING' } });
      expect(JSON.stringify(payload)).not.toContain(storageRoot);
    });
  });
});

async function waitForStatus(
  baseUrl: string,
  executionId: string,
  status: string,
  deadlineMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const payload = await fetch(`${baseUrl}/api/rpa/executions/${executionId}`).then((res) => res.json());
    if (payload.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${executionId} to reach ${status}`);
}

import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileExecutionStore } from '../../../src/server/executor/execution-store.js';

async function createTempStore() {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-exec-store-'));
  const store = createFileExecutionStore({
    storageRoot,
    idFactory: () => 'exec_test',
  });
  return { storageRoot, store };
}

describe('RPA execution store', () => {
  it('creates execution directories and redacts masked params in execution metadata', async () => {
    const { storageRoot, store } = await createTempStore();

    const record = await store.createExecution({
      flowId: 'case_query',
      daemonRunId: 'run_1',
      mode: 'verify',
      dryRun: true,
      headless: false,
      timeoutMs: 30000,
      params: { case_no: 'A123', org: '320100' },
      maskedParamIds: ['case_no'],
    });

    const executionDir = path.join(storageRoot, 'executions', record.executionId);
    await expect(stat(path.join(executionDir, 'logs'))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(stat(path.join(executionDir, 'artifacts'))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });

    const executionJson = JSON.parse(await readFile(path.join(executionDir, 'execution.json'), 'utf8'));
    const paramsJson = JSON.parse(await readFile(path.join(executionDir, 'run.params.json'), 'utf8'));

    expect(executionJson.paramsSummary).toEqual({ case_no: '[masked]', org: '320100' });
    expect(paramsJson).toEqual({ case_no: 'A123', org: '320100' });
  });

  it('appends sanitized logs and execution events', async () => {
    const { storageRoot, store } = await createTempStore();
    const record = await store.createExecution({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      timeoutMs: 30000,
      params: {},
      maskedParamIds: [],
    });

    const seen: string[] = [];
    const subscription = store.subscribe(record.executionId);
    const reader = (async () => {
      for await (const event of subscription) {
        seen.push(event.type);
      }
    })();

    await store.appendEvent({ type: 'run.started', executionId: record.executionId, timestamp: '2026-06-06T00:00:00.000Z' });
    await store.appendLog(record.executionId, 'stdout', `${storageRoot}/flows/case_query/flow.hardened.py started`);
    await store.appendEvent({
      type: 'run.completed',
      executionId: record.executionId,
      timestamp: '2026-06-06T00:00:01.000Z',
      status: 'succeeded',
      exitCode: 0,
    });
    await reader;

    expect(seen).toEqual(['run.started', 'log', 'run.completed']);
    const logs = await store.getLogs(record.executionId);
    expect(logs.stdout).toContain('[rpa-storage]/flows/case_query/flow.hardened.py started');
    expect(logs.stdout).not.toContain(storageRoot);

    const eventLines = (await readFile(path.join(storageRoot, 'executions', record.executionId, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(eventLines.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it('replays persisted events to late subscribers and closes after terminal event', async () => {
    const { store } = await createTempStore();
    const record = await store.createExecution({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      timeoutMs: 30000,
      params: {},
      maskedParamIds: [],
    });

    await store.appendEvent({ type: 'run.started', executionId: record.executionId, timestamp: '2026-06-06T00:00:00.000Z' });
    await store.appendEvent({
      type: 'run.completed',
      executionId: record.executionId,
      timestamp: '2026-06-06T00:00:01.000Z',
      status: 'succeeded',
      exitCode: 0,
    });

    const seen = [];
    for await (const event of store.subscribe(record.executionId)) {
      seen.push(event.type);
    }

    expect(seen).toEqual(['run.started', 'run.completed']);
  });

  it('does not lose a terminal event appended while a subscriber is replaying history', async () => {
    const { store } = await createTempStore();
    const record = await store.createExecution({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      timeoutMs: 30000,
      params: {},
      maskedParamIds: [],
    });
    await store.appendEvent({ type: 'run.started', executionId: record.executionId, timestamp: '2026-06-06T00:00:00.000Z' });

    const seen: string[] = [];
    const reader = (async () => {
      for await (const event of store.subscribe(record.executionId)) {
        seen.push(event.type);
      }
    })();
    await store.appendEvent({
      type: 'run.completed',
      executionId: record.executionId,
      timestamp: '2026-06-06T00:00:01.000Z',
      status: 'succeeded',
      exitCode: 0,
    });
    await reader;

    expect(seen).toEqual(['run.started', 'run.completed']);
  });

  it('records terminal execution status', async () => {
    const { store } = await createTempStore();
    const record = await store.createExecution({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      timeoutMs: 30000,
      params: {},
      maskedParamIds: [],
    });

    await store.markRunning(record.executionId);
    await store.finishExecution(record.executionId, {
      status: 'failed',
      failedStepId: 'open_query',
      error: { code: 'SCRIPT_FAILED', message: 'Script failed' },
    });

    const current = await store.getExecution(record.executionId);
    expect(current.status).toBe('failed');
    expect(current.failedStepId).toBe('open_query');
    expect(current.finishedAt).toEqual(expect.any(String));
  });
});

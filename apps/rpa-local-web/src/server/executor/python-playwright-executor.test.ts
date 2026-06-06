import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl } from '../../shared/dsl-schema.js';
import { requiredGenerationArtifactNames } from '../../shared/artifacts.js';
import { createPythonPlaywrightExecutor } from './python-playwright-executor.js';
import type { RpaExecutionEvent } from './execution-types.js';

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
  return flowDir;
}

async function createFakeRunner(storageRoot: string, behavior: 'success' | 'fail' | 'sleep') {
  const runnerPath = path.join(storageRoot, `fake-${behavior}.mjs`);
  const source = `
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const executionDir = args[args.indexOf('--execution-dir') + 1];
console.log('script path ' + args[0]);
console.log('execution dir ' + executionDir);

if ('${behavior}' === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

if ('${behavior}' === 'fail') {
  console.error('failure at ' + executionDir);
  process.exit(7);
}

await mkdir(path.join(executionDir, 'artifacts', 'screenshots'), { recursive: true });
await writeFile(path.join(executionDir, 'artifacts', 'screenshots', 'open_query.png'), 'fake screenshot');
console.log('done');
`;
  await writeFile(runnerPath, source);
  return runnerPath;
}

async function collectUntilTerminal(events: AsyncIterable<RpaExecutionEvent>): Promise<RpaExecutionEvent[]> {
  const seen: RpaExecutionEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (event.type === 'run.completed') break;
  }
  return seen;
}

describe('Python Playwright executor', () => {
  it('runs a fake verify script, captures logs, artifacts, and terminal success', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-exec-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'success');
    const executor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: process.execPath,
      pythonArgs: [runnerPath],
    });

    const started = await executor.start({
      flowId: 'case_query',
      daemonRunId: 'run_1',
      mode: 'verify',
      dryRun: true,
      headless: false,
      params: { case_no: 'A123', org: '320100' },
    });
    const events = await collectUntilTerminal(executor.subscribe(started.executionId));

    expect(started).toMatchObject({ flowId: 'case_query', status: 'queued', daemonRunId: 'run_1' });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['run.started', 'log', 'artifact.created', 'run.completed']),
    );
    await expect(executor.getStatus(started.executionId)).resolves.toMatchObject({ status: 'succeeded' });
    const logs = await executor.getLogs(started.executionId);
    expect(logs.stdout).toContain('[rpa-storage]/flows/case_query/flow.hardened.py');
    expect(logs.stdout).not.toContain(storageRoot);
    await expect(executor.listArtifacts(started.executionId)).resolves.toMatchObject({
      artifacts: [expect.objectContaining({ role: 'screenshot', fileName: 'open_query.png' })],
    });
  });

  it('maps non-zero exit to failed status without leaking absolute paths', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-fail-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'fail');
    const executor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: process.execPath,
      pythonArgs: [runnerPath],
    });

    const started = await executor.start({ flowId: 'case_query', mode: 'verify', params: {} });
    await collectUntilTerminal(executor.subscribe(started.executionId));

    const status = await executor.getStatus(started.executionId);
    expect(status.status).toBe('failed');
    expect(status.error?.message).not.toContain(storageRoot);
    const logs = await executor.getLogs(started.executionId);
    expect(logs.stderr).toContain('[rpa-storage]');
    expect(logs.stderr).not.toContain(storageRoot);
  });

  it('maps timeout and cancel to terminal statuses', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-timeout-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'sleep');
    const timeoutExecutor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: process.execPath,
      pythonArgs: [runnerPath],
    });

    const timed = await timeoutExecutor.start({
      flowId: 'case_query',
      mode: 'verify',
      timeoutMs: 50,
      params: {},
    });
    await collectUntilTerminal(timeoutExecutor.subscribe(timed.executionId));
    await expect(timeoutExecutor.getStatus(timed.executionId)).resolves.toMatchObject({ status: 'timed_out' });

    const cancelExecutor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: process.execPath,
      pythonArgs: [runnerPath],
    });
    const canceled = await cancelExecutor.start({
      flowId: 'case_query',
      mode: 'verify',
      timeoutMs: 5000,
      params: {},
    });
    await cancelExecutor.cancel(canceled.executionId);
    await collectUntilTerminal(cancelExecutor.subscribe(canceled.executionId));
    await expect(cancelExecutor.getStatus(canceled.executionId)).resolves.toMatchObject({ status: 'canceled' });
  });

  it('redacts masked params in execution metadata while preserving run params', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-mask-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'success');
    const executor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: process.execPath,
      pythonArgs: [runnerPath],
    });

    const started = await executor.start({
      flowId: 'case_query',
      mode: 'verify',
      params: { case_no: 'A123', org: '320100' },
    });
    await collectUntilTerminal(executor.subscribe(started.executionId));

    const executionDir = path.join(storageRoot, 'executions', started.executionId);
    const executionJson = JSON.parse(await readFile(path.join(executionDir, 'execution.json'), 'utf8'));
    const paramsJson = JSON.parse(await readFile(path.join(executionDir, 'run.params.json'), 'utf8'));
    expect(executionJson.paramsSummary.case_no).toBe('[masked]');
    expect(paramsJson.case_no).toBe('A123');
  });

  it('fails before spawn when required flow artifacts are missing', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-missing-'));
    await mkdir(path.join(storageRoot, 'flows', 'case_query'), { recursive: true });
    const runnerPath = await createFakeRunner(storageRoot, 'success');
    const executor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: process.execPath,
      pythonArgs: [runnerPath],
    });

    await expect(executor.start({ flowId: 'case_query', mode: 'verify', params: {} })).rejects.toMatchObject({
      code: 'FLOW_ARTIFACT_MISSING',
      message: expect.not.stringContaining(storageRoot),
    });
  });
});

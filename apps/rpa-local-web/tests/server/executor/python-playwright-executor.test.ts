import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMinimalRpaDsl } from '../../../src/shared/dsl-schema.js';
import { requiredGenerationArtifactNames, type RpaFlowLocalMetadata } from '../../../src/shared/artifacts.js';
import { createPythonPlaywrightExecutor } from '../../../src/server/executor/python-playwright-executor.js';
import type { RpaExecutionEvent } from '../../../src/server/executor/execution-types.js';
import { writeFlowLocalMetadata } from '../../../src/server/flow-store.js';

async function createFlow(
  storageRoot: string,
  flowId = 'case_query',
  metadata?: Partial<RpaFlowLocalMetadata>,
) {
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
  if (metadata) {
    await writeFlowLocalMetadata(flowDir, {
      schemaVersion: 'rpa-flow-local.v0.1',
      flowId,
      source: metadata.source ?? 'generated',
      createdAt: metadata.createdAt ?? '2026-06-06T00:00:00.000Z',
      requiresVerifyBeforeRun: metadata.requiresVerifyBeforeRun ?? false,
      generator: metadata.generator,
      imported: metadata.imported,
      verified: metadata.verified,
    });
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

    const started = await executor.start({ flowId: 'case_query', mode: 'verify', params: { case_no: 'A123' } });
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
      params: { case_no: 'A123' },
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
      params: { case_no: 'A123' },
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

  it('rejects missing required runtime params before creating an execution', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-param-validation-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'success');
    const executor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: process.execPath,
      pythonArgs: [runnerPath],
    });

    await expect(executor.start({ flowId: 'case_query', mode: 'verify', params: {} })).rejects.toMatchObject({
      code: 'PARAMS_INVALID',
    });
    await expect(readdir(path.join(storageRoot, 'executions'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects imported production run until local verify succeeds', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-imported-gate-'));
    await createFlow(storageRoot, 'case_query', {
      source: 'imported',
      requiresVerifyBeforeRun: true,
      imported: {
        originalFlowId: 'case_query',
        packageSha256: 'sha256:abc',
      },
    });
    const runnerPath = await createFakeRunner(storageRoot, 'success');
    const executor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: process.execPath,
      pythonArgs: [runnerPath],
    });

    await expect(
      executor.start({ flowId: 'case_query', mode: 'run', params: { case_no: 'A123' } }),
    ).rejects.toMatchObject({ code: 'FLOW_VERIFY_REQUIRED' });
    await expect(readdir(path.join(storageRoot, 'executions'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marks imported flow verified after successful verify', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-imported-verify-'));
    await createFlow(storageRoot, 'case_query', {
      source: 'imported',
      requiresVerifyBeforeRun: true,
      imported: {
        originalFlowId: 'case_query',
        packageSha256: 'sha256:abc',
      },
    });
    const runnerPath = await createFakeRunner(storageRoot, 'success');
    const executor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: process.execPath,
      pythonArgs: [runnerPath],
    });

    const started = await executor.start({
      flowId: 'case_query',
      mode: 'verify',
      params: { case_no: 'A123' },
    });
    await collectUntilTerminal(executor.subscribe(started.executionId));

    const metadata = JSON.parse(
      await readFile(path.join(storageRoot, 'flows', 'case_query', 'flow.local.json'), 'utf8'),
    );
    expect(metadata.requiresVerifyBeforeRun).toBe(false);
    expect(metadata.verified.executionId).toBe(started.executionId);
  });
});

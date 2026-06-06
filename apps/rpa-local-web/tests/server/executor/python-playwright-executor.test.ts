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

async function createFakeRunner(storageRoot: string, behavior: 'success' | 'runtime' | 'fail' | 'sleep') {
  const runnerPath = path.join(storageRoot, `fake-${behavior}.sh`);
  const source = `
#!/bin/sh
set -eu

execution_dir=""
next_is_execution_dir=0
args_json="["
first_arg=1

for arg in "$@"; do
  if [ "$next_is_execution_dir" = "1" ]; then
    execution_dir="$arg"
    next_is_execution_dir=0
  fi
  if [ "$arg" = "--execution-dir" ]; then
    next_is_execution_dir=1
  fi

  escaped=$(printf '%s' "$arg" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
  if [ "$first_arg" = "1" ]; then
    first_arg=0
  else
    args_json="$args_json,"
  fi
  args_json="$args_json\\"$escaped\\""
done
args_json="$args_json]"

printf 'script path %s\\n' "$1"
printf 'execution dir %s\\n' "$execution_dir"
printf '%s' "$args_json" > "$execution_dir/args.json"

if [ '${behavior}' = 'sleep' ]; then
  sleep 5 &
  sleep_pid=$!
  trap 'kill "$sleep_pid" 2>/dev/null || true; exit 143' TERM INT
  wait "$sleep_pid"
fi

if [ '${behavior}' = 'fail' ]; then
  printf 'failure at %s\\n' "$execution_dir" >&2
  exit 7
fi

if [ '${behavior}' = 'runtime' ]; then
  mkdir -p "$execution_dir/runtime/screenshots"
  printf 'fake screenshot 1' > "$execution_dir/runtime/screenshots/open.png"
  printf 'fake screenshot 2' > "$execution_dir/runtime/screenshots/extract.png"
  printf '{"rows":1}' > "$execution_dir/runtime/custom-result.json"
  printf '%s\\n' \\
    '{"flow_id":"case_query","step_id":"s1","step_name":"Open page","status":"start","ts":"2026-06-06T00:00:00.000Z"}' \\
    '{"flow_id":"case_query","step_id":"s1","step_name":"Open page","status":"ok","screenshot":"'"$execution_dir"'/runtime/screenshots/open.png","ts":"2026-06-06T00:00:01.000Z"}' \\
    '{"flow_id":"case_query","step_id":"s2","step_name":"Extract result","status":"start","ts":"2026-06-06T00:00:02.000Z"}' \\
    '{"flow_id":"case_query","step_id":"s2","step_name":"Extract result","status":"ok","result_json":"'"$execution_dir"'/runtime/custom-result.json","screenshot":"'"$execution_dir"'/runtime/screenshots/extract.png","ts":"2026-06-06T00:00:03.000Z"}' \\
    > "$execution_dir/runtime/audit.jsonl"
  printf 'done\\n'
  exit 0
fi

mkdir -p "$execution_dir/artifacts/screenshots"
printf 'fake screenshot' > "$execution_dir/artifacts/screenshots/open_query.png"
printf 'done\\n'
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
      pythonCommand: '/bin/sh',
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

  it('publishes script audit step events and discovers generic runtime outputs', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-runtime-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'runtime');
    const executor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: '/bin/sh',
      pythonArgs: [runnerPath],
    });

    const started = await executor.start({
      flowId: 'case_query',
      mode: 'verify',
      dryRun: true,
      headless: false,
      params: { case_no: 'A123' },
    });
    const events = await collectUntilTerminal(executor.subscribe(started.executionId));

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'run.started',
        'step.started',
        'step.screenshot',
        'step.completed',
        'artifact.created',
        'run.completed',
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'step.started', stepId: 's1' }),
        expect.objectContaining({
          type: 'step.screenshot',
          stepId: 's2',
          role: 'screenshot',
          relativePath: 'runtime/screenshots/extract.png',
        }),
        expect.objectContaining({
          type: 'artifact.created',
          role: 'other',
          relativePath: 'runtime/custom-result.json',
        }),
      ]),
    );
    await expect(executor.listArtifacts(started.executionId)).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: 'other', fileName: 'custom-result.json' }),
        expect.objectContaining({ role: 'screenshot', relativePath: 'runtime/screenshots/extract.png' }),
      ]),
    });
    await expect(executor.resolveCurrentScreenshot(started.executionId)).resolves.toMatchObject({
      artifact: expect.objectContaining({
        role: 'screenshot',
        relativePath: 'runtime/screenshots/extract.png',
      }),
    });
  });

  it('passes the local executor CLI contract to generated scripts', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-cli-contract-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'success');
    const executor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: '/bin/sh',
      pythonArgs: [runnerPath],
    });

    const started = await executor.start({
      flowId: 'case_query',
      mode: 'run',
      dryRun: true,
      headless: false,
      params: { case_no: 'A123' },
    });
    await collectUntilTerminal(executor.subscribe(started.executionId));

    const argsJson = JSON.parse(
      await readFile(path.join(storageRoot, 'executions', started.executionId, 'args.json'), 'utf8'),
    ) as string[];
    expect(argsJson).toEqual(
      expect.arrayContaining(['--mode', 'run', '--params', '--execution-dir', '--dry-run', '--headed']),
    );
    expect(argsJson).not.toContain('--headless');
  });

  it('maps non-zero exit to failed status without leaking absolute paths', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-python-fail-'));
    await createFlow(storageRoot);
    const runnerPath = await createFakeRunner(storageRoot, 'fail');
    const executor = createPythonPlaywrightExecutor({
      storageRoot,
      pythonCommand: '/bin/sh',
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
      pythonCommand: '/bin/sh',
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
      pythonCommand: '/bin/sh',
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
      pythonCommand: '/bin/sh',
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
      pythonCommand: '/bin/sh',
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
      pythonCommand: '/bin/sh',
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
      pythonCommand: '/bin/sh',
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
      pythonCommand: '/bin/sh',
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

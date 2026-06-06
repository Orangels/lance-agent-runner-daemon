import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRpaExecutionMaterials } from '../../../src/server/observability/rpa-execution-materials.js';

describe('RPA execution materials', () => {
  it('collects sanitized execution JSON, logs, events, and large file references', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-exec-materials-'));
    const executionDir = path.join(storageRoot, 'executions', 'exec_1');
    await mkdir(path.join(executionDir, 'logs'), { recursive: true });
    await mkdir(path.join(executionDir, 'artifacts', 'screenshots'), { recursive: true });
    await writeFile(
      path.join(executionDir, 'execution.json'),
      JSON.stringify(
        {
          executionId: 'exec_1',
          flowId: 'case_query',
          daemonRunId: 'run_1',
          mode: 'verify',
          dryRun: true,
          headless: false,
          status: 'failed',
          createdAt: '2026-06-06T00:00:00.000Z',
          timeoutMs: 1000,
          paramsSummary: { case_no: '[masked]' },
          failedStepId: 'search',
          error: { code: 'STEP_TARGET_NOT_FOUND', message: `missing ${storageRoot} 13800138000` },
        },
        null,
        2,
      ),
    );
    await writeFile(path.join(executionDir, 'logs', 'stdout.log'), `case_no=A123 ${storageRoot}\n`);
    await writeFile(
      path.join(executionDir, 'events.jsonl'),
      '{"type":"step.failed","executionId":"exec_1","stepId":"search","timestamp":"2026-06-06T00:00:01.000Z"}\n',
    );
    await writeFile(path.join(executionDir, 'artifacts', 'screenshots', 'search.png'), 'fake screenshot');

    const materials = await collectRpaExecutionMaterials({
      storageRoot,
      executionIds: ['exec_1'],
      collectionMode: 'diagnostic',
      redaction: { storageRoot, maskedParamIds: ['case_no'], params: { case_no: 'A123' } },
      includeSensitiveFiles: false,
    });

    expect(materials.entries.map((entry) => entry.path)).toContain('executions/exec_1/execution.json');
    expect(materials.entries.map((entry) => entry.path)).toContain('executions/exec_1/execution-log.jsonl');
    expect(JSON.stringify(materials.entries)).not.toContain(storageRoot);
    expect(JSON.stringify(materials.entries)).not.toContain('A123');
    expect(materials.largeFiles[0]).toMatchObject({
      kind: 'screenshot',
      included: false,
      path: 'extensions/rpa/executions/exec_1/artifacts/screenshots/search.png',
    });
  });

  it('uses collectionMode to decide execution log detail', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-exec-collection-'));
    const executionDir = path.join(storageRoot, 'executions', 'exec_1');
    await mkdir(path.join(executionDir, 'logs'), { recursive: true });
    await writeFile(
      path.join(executionDir, 'execution.json'),
      JSON.stringify({
        executionId: 'exec_1',
        flowId: 'case_query',
        mode: 'verify',
        dryRun: true,
        headless: false,
        status: 'succeeded',
        createdAt: '2026-06-06T00:00:00.000Z',
        timeoutMs: 1000,
        paramsSummary: {},
      }),
    );
    await writeFile(path.join(executionDir, 'logs', 'stdout.log'), `${'x'.repeat(20000)}tail-marker`);

    const lite = await collectRpaExecutionMaterials({
      storageRoot,
      executionIds: ['exec_1'],
      collectionMode: 'lite',
      redaction: { storageRoot, maskedParamIds: [], params: {} },
      includeSensitiveFiles: false,
    });
    const diagnostic = await collectRpaExecutionMaterials({
      storageRoot,
      executionIds: ['exec_1'],
      collectionMode: 'diagnostic',
      redaction: { storageRoot, maskedParamIds: [], params: {} },
      includeSensitiveFiles: false,
    });

    expect(lite.entries.map((entry) => entry.path)).not.toContain('executions/exec_1/execution-log.jsonl');
    expect(lite.largeFiles).toEqual([expect.objectContaining({ kind: 'log', included: false })]);
    expect(JSON.stringify(diagnostic.entries)).toContain('tail-marker');
    expect(JSON.stringify(diagnostic.entries)).not.toContain('x'.repeat(20000));
  });
});

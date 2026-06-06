import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPlaywrightCodegenRunner } from '../../src/server/codegen/playwright-codegen-runner.js';
import type { SpawnProcess } from '../../src/server/codegen/playwright-codegen-runner.js';

async function createFakeCodegen(storageRoot: string, behavior: 'success' | 'fail' | 'missing' | 'empty' | 'sleep') {
  const scriptPath = path.join(storageRoot, `fake-codegen-${behavior}.mjs`);
  const source = `
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const outPath = args[args.indexOf('-o') + 1];
const targetUrl = args.at(-1);
console.log('argv:' + JSON.stringify(args));
console.error('recording to ' + outPath);

if ('${behavior}' === 'sleep') {
  process.on('SIGTERM', () => process.exit(0));
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

if ('${behavior}' === 'fail') {
  console.error('failed under ' + path.dirname(outPath));
  process.exit(9);
}

if ('${behavior}' !== 'missing') {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, '${behavior}' === 'empty' ? '' : '# generated for ' + targetUrl + '\\n');
}
`;
  await writeFile(scriptPath, source);
  return scriptPath;
}

async function tempStorage(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Playwright codegen runner', () => {
  it('runs a fake command that writes flow.py', async () => {
    const storageRoot = await tempStorage('rpa-codegen-success-');
    const fakeScript = await createFakeCodegen(storageRoot, 'success');
    const outputPath = path.join(storageRoot, 'codegen-sessions', 'cg_1', 'input', 'flow.py');
    const runner = createPlaywrightCodegenRunner({
      command: process.execPath,
      args: [fakeScript],
      storageRoot,
    });

    const result = await runner
      .start({
        scriptPath: outputPath,
        targetUrl: 'https://example.com/start',
      })
      .done;

    await expect(stat(outputPath)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(readFile(outputPath, 'utf8')).resolves.toContain('# generated for https://example.com/start');
    expect(result).toEqual({ status: 'completed', scriptPath: outputPath });
  });

  it('fails when the fake command exits non-zero without leaking the storage root', async () => {
    const storageRoot = await tempStorage('rpa-codegen-fail-');
    const fakeScript = await createFakeCodegen(storageRoot, 'fail');
    const runner = createPlaywrightCodegenRunner({
      command: process.execPath,
      args: [fakeScript],
      storageRoot,
    });

    await expect(
      runner.start({ scriptPath: path.join(storageRoot, 'input', 'flow.py'), targetUrl: 'https://example.com' })
        .done,
    ).rejects.toMatchObject({
      code: 'CODEGEN_PROCESS_FAILED',
      message: expect.not.stringContaining(storageRoot),
      publicMessage: expect.not.stringContaining(storageRoot),
    });
  });

  it('cancels a long-running fake command', async () => {
    const storageRoot = await tempStorage('rpa-codegen-cancel-');
    const fakeScript = await createFakeCodegen(storageRoot, 'sleep');
    const runner = createPlaywrightCodegenRunner({
      command: process.execPath,
      args: [fakeScript],
      storageRoot,
    });

    const handle = runner.start({
      scriptPath: path.join(storageRoot, 'input', 'flow.py'),
      targetUrl: 'https://example.com',
    });
    handle.cancel();

    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled' });
  });

  it.each(['missing', 'empty'] as const)('fails when flow.py is %s after a zero exit', async (behavior) => {
    const storageRoot = await tempStorage(`rpa-codegen-${behavior}-`);
    const fakeScript = await createFakeCodegen(storageRoot, behavior);
    const runner = createPlaywrightCodegenRunner({
      command: process.execPath,
      args: [fakeScript],
      storageRoot,
    });

    const done = runner.start({
      scriptPath: path.join(storageRoot, 'input', 'flow.py'),
      targetUrl: 'https://example.com',
    }).done;

    await expect(done).rejects.toMatchObject({
      code: 'CODEGEN_OUTPUT_MISSING',
      publicMessage: expect.stringContaining('[rpa-storage]'),
    });
    await expect(done).rejects.toMatchObject({
      code: 'CODEGEN_OUTPUT_MISSING',
      publicMessage: expect.not.stringContaining(storageRoot),
    });
  });

  it('spawns with shell false and an args array ending in the target URL', async () => {
    const storageRoot = await tempStorage('rpa-codegen-spawn-');
    const outputPath = path.join(storageRoot, 'input', 'flow.py');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, '# already written by fake spawn\n');
    const stdoutListeners: Array<(chunk: string) => void> = [];
    const stderrListeners: Array<(chunk: string) => void> = [];
    const spawnProcess = vi.fn<SpawnProcess>(() => ({
      stdout: {
        setEncoding: vi.fn(),
        on: vi.fn((event: 'data', listener: (chunk: string) => void) => {
          if (event === 'data') stdoutListeners.push(listener);
        }),
      },
      stderr: {
        setEncoding: vi.fn(),
        on: vi.fn((event: 'data', listener: (chunk: string) => void) => {
          if (event === 'data') stderrListeners.push(listener);
        }),
      },
      once: vi.fn((event: 'error' | 'close', callback: unknown) => {
        if (event === 'close') {
          queueMicrotask(() => {
            stdoutListeners.forEach((listener) => listener(`writing ${outputPath}\n`));
            stderrListeners.forEach((listener) => listener(`debug ${storageRoot}\n`));
            (callback as (code: number | null, signal: NodeJS.Signals | null) => void)(0, null);
          });
        }
        return undefined;
      }),
      kill: vi.fn(),
    }));
    const targetUrl = 'https://example.com/path?q=a b&x=$(echo unsafe)';
    const logs: Array<{ stream: 'stdout' | 'stderr'; line: string }> = [];
    const runner = createPlaywrightCodegenRunner({
      command: 'fake-playwright',
      args: ['codegen', '--browser', 'chromium'],
      storageRoot,
      maxLogLineBytes: 64,
      maxTotalLogBytes: 128,
      spawnProcess,
    });

    await runner.start({ scriptPath: outputPath, targetUrl, appendLog: (entry) => logs.push(entry) }).done;

    expect(spawnProcess).toHaveBeenCalledWith(
      'fake-playwright',
      ['codegen', '--browser', 'chromium', '--target', 'python', '-o', outputPath, targetUrl],
      expect.objectContaining({ shell: false }),
    );
    expect(logs.map((entry) => entry.stream)).toEqual(expect.arrayContaining(['stdout', 'stderr']));
    expect(logs.map((entry) => entry.line).join('\n')).toContain('[rpa-storage]');
    expect(logs.map((entry) => entry.line).join('\n')).not.toContain(storageRoot);
    expect(logs.every((entry) => entry.line.length <= 64)).toBe(true);
    expect(logs.reduce((total, entry) => total + entry.line.length, 0)).toBeLessThanOrEqual(128);
  });

  it('validates targetUrl before spawning', async () => {
    const storageRoot = await tempStorage('rpa-codegen-url-');
    const spawnProcess = vi.fn();
    const runner = createPlaywrightCodegenRunner({
      command: 'fake-playwright',
      args: ['codegen'],
      storageRoot,
      spawnProcess,
    });

    await expect(
      runner.start({ scriptPath: path.join(storageRoot, 'input', 'flow.py'), targetUrl: 'file:///etc/passwd' })
        .done,
    ).rejects.toMatchObject({ code: 'INVALID_TARGET_URL' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

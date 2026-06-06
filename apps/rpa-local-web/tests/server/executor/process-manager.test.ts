import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startManagedProcess } from '../../../src/server/executor/process-manager.js';

async function writeChildScript(name: string, source: string): Promise<{ cwd: string; scriptPath: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'rpa-process-manager-'));
  const scriptPath = path.join(cwd, name);
  await writeFile(scriptPath, source);
  return { cwd, scriptPath };
}

describe('startManagedProcess', () => {
  it('captures stdout lines and reports a successful exit', async () => {
    const { cwd, scriptPath } = await writeChildScript(
      'success.js',
      [
        "process.stdout.write('first line\\nsecond line\\npartial');",
      ].join('\n'),
    );
    const stdout: string[] = [];

    const handle = startManagedProcess({
      command: process.execPath,
      args: [scriptPath],
      cwd,
      timeoutMs: 5_000,
      onStdoutLine: (line) => stdout.push(line),
    });

    await expect(handle.done).resolves.toEqual({
      exitCode: 0,
      signal: null,
      canceled: false,
      timedOut: false,
    });
    expect(stdout).toEqual(['first line', 'second line', 'partial']);
  });

  it('captures stderr lines and reports a failing exit code', async () => {
    const { cwd, scriptPath } = await writeChildScript(
      'failure.js',
      [
        "process.stderr.write('warning\\nlast error');",
        'process.exitCode = 7;',
      ].join('\n'),
    );
    const stderr: string[] = [];

    const handle = startManagedProcess({
      command: process.execPath,
      args: [scriptPath],
      cwd,
      timeoutMs: 5_000,
      onStderrLine: (line) => stderr.push(line),
    });

    await expect(handle.done).resolves.toEqual({
      exitCode: 7,
      signal: null,
      canceled: false,
      timedOut: false,
    });
    expect(stderr).toEqual(['warning', 'last error']);
  });

  it('can cancel a long-running child process', async () => {
    const { cwd, scriptPath } = await writeChildScript(
      'cancel.js',
      [
        "console.log('ready');",
        'setInterval(() => undefined, 100);',
      ].join('\n'),
    );
    const stdout: string[] = [];

    const handle = startManagedProcess({
      command: process.execPath,
      args: [scriptPath],
      cwd,
      timeoutMs: 5_000,
      onStdoutLine: (line) => {
        stdout.push(line);
        handle.cancel();
      },
    });

    const result = await handle.done;

    expect(stdout).toEqual(['ready']);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
    expect(result.canceled).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('terminates a timed-out child process and marks the result as timed out', async () => {
    const { cwd, scriptPath } = await writeChildScript(
      'timeout.js',
      [
        "console.log('started');",
        'setInterval(() => undefined, 100);',
      ].join('\n'),
    );
    const stdout: string[] = [];

    const handle = startManagedProcess({
      command: process.execPath,
      args: [scriptPath],
      cwd,
      timeoutMs: 500,
      onStdoutLine: (line) => stdout.push(line),
    });

    const result = await handle.done;

    expect(stdout).toEqual(['started']);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
    expect(result.canceled).toBe(true);
    expect(result.timedOut).toBe(true);
  });
});

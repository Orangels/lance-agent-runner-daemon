import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonLogger } from '../daemon-logger.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'daemon-logger-test-'));
  tempDirs.push(dir);
  return dir;
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('daemon logger', () => {
  it('writes service info events to daemon.log as JSON lines', () => {
    const dataDir = makeDataDir();
    const logger = createDaemonLogger({ dataDir, now: () => 1770000000000 });

    logger.info('daemon_started', { profileCount: 1 });

    expect(readJsonLines(path.join(dataDir, 'logs', 'daemon.log'))).toEqual([
      {
        event: 'daemon_started',
        level: 'info',
        profileCount: 1,
        time: 1770000000000,
      },
    ]);
  });

  it('duplicates warn and error events into daemon-error.log with error details', () => {
    const dataDir = makeDataDir();
    const logger = createDaemonLogger({ dataDir, now: () => 1770000000000 });

    logger.warn('queue_delay', { runId: 'run_1' });
    logger.error('http_error', { error: new Error('download failed'), path: '/api/runs/run_1/artifacts/a/download' });

    const serviceLines = readJsonLines(path.join(dataDir, 'logs', 'daemon.log'));
    const errorLines = readJsonLines(path.join(dataDir, 'logs', 'daemon-error.log'));
    expect(serviceLines.map((line) => line.event)).toEqual(['queue_delay', 'http_error']);
    expect(errorLines.map((line) => line.event)).toEqual(['queue_delay', 'http_error']);
    expect(errorLines[1]).toEqual(
      expect.objectContaining({
        errorMessage: 'download failed',
        errorName: 'Error',
        event: 'http_error',
        level: 'error',
        path: '/api/runs/run_1/artifacts/a/download',
      }),
    );
    expect(String(errorLines[1]!.errorStack)).toContain('download failed');
  });

  it('redacts secret-like fields before writing local service logs', () => {
    const dataDir = makeDataDir();
    const logger = createDaemonLogger({ dataDir, now: () => 1770000000000 });

    logger.info('request_received', {
      apiKey: 'secret-api-key',
      authorization: 'Bearer secret-token',
      nested: { token: 'secret-token', safe: 'value' },
    });

    const text = readFileSync(path.join(dataDir, 'logs', 'daemon.log'), 'utf8');
    expect(text).not.toContain('secret-api-key');
    expect(text).not.toContain('secret-token');
    expect(text).toContain('[redacted]');
    expect(text).toContain('value');
  });

  it('does not throw when local service log writes fail', () => {
    const dataDir = path.join(makeDataDir(), 'not-a-directory');
    writeFileSync(dataDir, 'file');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createDaemonLogger({ dataDir, now: () => 1770000000000 });

    expect(() => logger.error('http_error', { error: new Error('download failed') })).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('Failed to write daemon service log:', expect.any(String));
  });
});

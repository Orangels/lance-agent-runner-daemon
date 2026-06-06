import { describe, expect, it, vi } from 'vitest';
import { consumeDaemonRun } from '../../../src/server/workflows/daemon-run-consumer.js';

describe('daemon run consumer', () => {
  it('returns transcript and terminal status while forwarding artifact and error log lines', async () => {
    const daemonClient = {
      subscribeRunEvents: vi.fn(async function* () {
        yield { id: '1', event: { type: 'text_delta', delta: 'hello ' } };
        yield {
          id: '2',
          event: {
            type: 'artifact_finalized',
            artifact: artifactEvent('flow.dsl.json'),
          },
        };
        yield { id: '3', event: { type: 'error', code: 'WARN_ONLY', message: 'Recoverable warning.' } };
        yield { id: '4', event: { type: 'text_delta', delta: 'world' } };
        yield { id: '5', event: { type: 'end', status: 'succeeded' } };
      }),
    };
    const logs: string[] = [];

    const result = await consumeDaemonRun({
      daemonClient,
      runId: 'run_1',
      appendLog: async (message) => {
        logs.push(message);
      },
    });

    expect(result).toEqual({ transcript: 'hello world', terminalStatus: 'succeeded' });
    expect(logs).toEqual([
      'Artifact created: output/flow.dsl.json',
      'WARN_ONLY: Recoverable warning.',
    ]);
    expect(daemonClient.subscribeRunEvents).toHaveBeenCalledWith('run_1');
  });
});

function artifactEvent(fileName: string) {
  return {
    id: `art_${fileName}`,
    runId: 'run_1',
    ruleId: 'rpa-output',
    role: 'primary' as const,
    relativePath: `output/${fileName}`,
    fileName,
    mimeType: fileName.endsWith('.json') ? 'application/json' : 'text/plain',
    size: 100,
    mtime: 1,
    sha256: 'a'.repeat(64),
  };
}

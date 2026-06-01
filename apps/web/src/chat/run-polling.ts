import type { RunStatusResponse } from '../api/types.js';

type WaitForPoll = (intervalMs: number, signal?: AbortSignal) => Promise<void>;

export interface PollRunStatusInput {
  runId: string;
  getRunStatus: (runId: string) => Promise<RunStatusResponse>;
  onStatus?: (status: RunStatusResponse) => void;
  intervalMs?: number;
  signal?: AbortSignal;
  wait?: WaitForPoll;
}

export type PollRunStatusResult =
  | {
      ok: true;
      status: RunStatusResponse;
    }
  | {
      ok: false;
      reason: 'aborted';
    };

export async function pollRunStatus(input: PollRunStatusInput): Promise<PollRunStatusResult> {
  const intervalMs = input.intervalMs ?? 1200;
  const wait = input.wait ?? waitForPoll;

  while (!input.signal?.aborted) {
    const status = await input.getRunStatus(input.runId);
    input.onStatus?.(status);

    if (status.terminal) {
      return { ok: true, status };
    }

    await wait(intervalMs, input.signal);
  }

  return { ok: false, reason: 'aborted' };
}

function waitForPoll(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, intervalMs);

    function onAbort() {
      window.clearTimeout(timeout);
      resolve();
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

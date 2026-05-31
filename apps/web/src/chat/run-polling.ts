import type { RunDetailResponse, RunStatus } from '../api/types.js';

const terminalStatuses = new Set<RunStatus>(['succeeded', 'failed', 'canceled', 'interrupted']);

type WaitForPoll = (intervalMs: number, signal?: AbortSignal) => Promise<void>;

export interface PollRunDetailInput {
  runId: string;
  getRunDetail: (runId: string) => Promise<RunDetailResponse>;
  onDetail?: (detail: RunDetailResponse) => void;
  intervalMs?: number;
  signal?: AbortSignal;
  wait?: WaitForPoll;
}

export type PollRunDetailResult =
  | {
      ok: true;
      detail: RunDetailResponse;
    }
  | {
      ok: false;
      reason: 'aborted';
    };

export async function pollRunDetail(input: PollRunDetailInput): Promise<PollRunDetailResult> {
  const intervalMs = input.intervalMs ?? 1200;
  const wait = input.wait ?? waitForPoll;

  while (!input.signal?.aborted) {
    const detail = await input.getRunDetail(input.runId);
    input.onDetail?.(detail);

    if (terminalStatuses.has(detail.run.status)) {
      return { ok: true, detail };
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

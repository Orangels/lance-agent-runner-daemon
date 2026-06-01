import { describe, expect, it, vi } from 'vitest';
import { pollRunStatus } from '../run-polling.js';
import type { RunStatusResponse } from '../../api/types.js';

function statusDetail(status: RunStatusResponse['run']['status']): RunStatusResponse {
  return {
    run: {
      id: 'run_1',
      workspaceId: 'ws_1',
      profileId: 'report-docx',
      kind: 'generate',
      skillId: 'report-gen',
      status,
      queuedAt: 1,
      startedAt: status === 'queued' ? null : 2,
      finishedAt: status === 'running' || status === 'queued' ? null : 3,
      createdAt: 1,
      updatedAt: 3,
      errorCode: null,
      errorMessage: null,
    },
    terminal: status !== 'queued' && status !== 'running',
  };
}

describe('pollRunStatus', () => {
  it('polls lightweight status until terminal status and reports each status snapshot', async () => {
    const getRunStatus = vi.fn()
      .mockResolvedValueOnce(statusDetail('queued'))
      .mockResolvedValueOnce(statusDetail('running'))
      .mockResolvedValueOnce(statusDetail('succeeded'));
    const onStatus = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);

    const result = await pollRunStatus({
      getRunStatus,
      intervalMs: 10,
      onStatus,
      runId: 'run_1',
      wait,
    });

    expect(result).toMatchObject({ ok: true, status: statusDetail('succeeded') });
    expect(getRunStatus).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('aborts cleanly before the next poll', async () => {
    const controller = new AbortController();
    const getRunStatus = vi.fn().mockResolvedValue(statusDetail('running'));
    const wait = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });

    const result = await pollRunStatus({
      getRunStatus,
      intervalMs: 10,
      runId: 'run_1',
      signal: controller.signal,
      wait,
    });

    expect(result).toEqual({ ok: false, reason: 'aborted' });
    expect(getRunStatus).toHaveBeenCalledTimes(1);
  });
});

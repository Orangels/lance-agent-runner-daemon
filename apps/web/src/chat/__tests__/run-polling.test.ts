import { describe, expect, it, vi } from 'vitest';
import { pollRunDetail } from '../run-polling.js';
import type { RunDetailResponse } from '../../api/types.js';

function detail(status: RunDetailResponse['run']['status']): RunDetailResponse {
  return {
    run: {
      id: 'run_1',
      workspaceId: 'ws_1',
      profileId: 'report-docx',
      kind: 'generate',
      skillId: 'report-gen',
      status,
      lastRunEventId: null,
      queuedAt: 1,
      startedAt: status === 'queued' ? null : 2,
      finishedAt: status === 'running' || status === 'queued' ? null : 3,
      createdAt: 1,
      updatedAt: 3,
    },
    messages: [],
  };
}

describe('pollRunDetail', () => {
  it('polls until terminal status and reports each detail', async () => {
    const getRunDetail = vi.fn()
      .mockResolvedValueOnce(detail('queued'))
      .mockResolvedValueOnce(detail('running'))
      .mockResolvedValueOnce(detail('succeeded'));
    const onDetail = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);

    const result = await pollRunDetail({
      getRunDetail,
      intervalMs: 10,
      onDetail,
      runId: 'run_1',
      wait,
    });

    expect(result).toMatchObject({ ok: true, detail: detail('succeeded') });
    expect(getRunDetail).toHaveBeenCalledTimes(3);
    expect(onDetail).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('aborts cleanly before the next poll', async () => {
    const controller = new AbortController();
    const getRunDetail = vi.fn().mockResolvedValue(detail('running'));
    const wait = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });

    const result = await pollRunDetail({
      getRunDetail,
      intervalMs: 10,
      runId: 'run_1',
      signal: controller.signal,
      wait,
    });

    expect(result).toEqual({ ok: false, reason: 'aborted' });
    expect(getRunDetail).toHaveBeenCalledTimes(1);
  });
});

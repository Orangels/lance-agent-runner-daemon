import { describe, expect, it } from 'vitest';
import {
  canStartCandidate,
  countQueued,
  countRunning,
  selectDispatchableCandidates,
  type QueueCandidate,
  type QueueLimits,
} from '../../src/core/run-queue.js';

const limits = (
  input: Partial<{
    globalConcurrency: number;
    profileConcurrencyById: Record<string, number>;
  }> = {},
): QueueLimits => ({
  globalConcurrency: input.globalConcurrency ?? 10,
  profileConcurrencyById: new Map(Object.entries(input.profileConcurrencyById ?? {})),
});

const candidate = (input: Partial<QueueCandidate> & Pick<QueueCandidate, 'runId'>): QueueCandidate => ({
  profileId: input.profileId ?? 'profile_a',
  workspaceId: input.workspaceId ?? 'ws_a',
  status: input.status ?? 'queued',
  sequence: input.sequence ?? 1,
  ...input,
});

describe('run queue selection', () => {
  it('counts queued and active capacity-consuming runs', () => {
    const candidates: QueueCandidate[] = [
      candidate({ runId: 'queued', status: 'queued' }),
      candidate({ runId: 'starting', status: 'starting' }),
      candidate({ runId: 'running', status: 'running' }),
      candidate({ runId: 'finishing', status: 'finishing' }),
      candidate({ runId: 'terminal', status: 'terminal' }),
    ];

    expect(countQueued(candidates)).toBe(1);
    expect(countRunning(candidates)).toBe(3);
  });

  it('enforces global concurrency', () => {
    const candidates = [
      candidate({ runId: 'running', status: 'running', workspaceId: 'ws_running' }),
      candidate({ runId: 'queued', workspaceId: 'ws_queued' }),
    ];

    expect(canStartCandidate(candidates[1]!, candidates, limits({ globalConcurrency: 1 }))).toBe(false);
    expect(selectDispatchableCandidates(candidates, limits({ globalConcurrency: 1 }))).toEqual([]);
  });

  it('enforces profile concurrency', () => {
    const candidates = [
      candidate({ runId: 'running', status: 'running', workspaceId: 'ws_running' }),
      candidate({ runId: 'queued', workspaceId: 'ws_queued' }),
    ];

    expect(
      canStartCandidate(candidates[1]!, candidates, limits({ profileConcurrencyById: { profile_a: 1 } })),
    ).toBe(false);
    expect(selectDispatchableCandidates(candidates, limits({ profileConcurrencyById: { profile_a: 1 } }))).toEqual([]);
  });

  it('enforces per-workspace serial execution', () => {
    const candidates = [
      candidate({ runId: 'running', status: 'running', workspaceId: 'ws_a' }),
      candidate({ runId: 'queued', workspaceId: 'ws_a', sequence: 2 }),
    ];

    expect(canStartCandidate(candidates[1]!, candidates, limits())).toBe(false);
    expect(selectDispatchableCandidates(candidates, limits())).toEqual([]);
  });

  it('keeps finishing runs capacity-consuming until finalization is complete', () => {
    const candidates = [
      candidate({ runId: 'finishing', status: 'finishing', workspaceId: 'ws_a' }),
      candidate({ runId: 'queued', workspaceId: 'ws_a', sequence: 2 }),
      candidate({ runId: 'other', workspaceId: 'ws_b', sequence: 3 }),
    ];

    expect(canStartCandidate(candidates[1]!, candidates, limits())).toBe(false);
    expect(selectDispatchableCandidates(candidates, limits()).map((item) => item.runId)).toEqual(['other']);
  });

  it('selects dispatchable queued runs in FIFO order when all are eligible', () => {
    const candidates = [
      candidate({ runId: 'third', workspaceId: 'ws_3', sequence: 3 }),
      candidate({ runId: 'first', workspaceId: 'ws_1', sequence: 1 }),
      candidate({ runId: 'second', workspaceId: 'ws_2', sequence: 2 }),
    ];

    expect(selectDispatchableCandidates(candidates, limits({ globalConcurrency: 2 })).map((item) => item.runId)).toEqual([
      'first',
      'second',
    ]);
  });

  it('does not let a workspace-blocked queued run block later eligible work', () => {
    const candidates = [
      candidate({ runId: 'running', status: 'running', workspaceId: 'ws_a', sequence: 1 }),
      candidate({ runId: 'blocked', workspaceId: 'ws_a', sequence: 2 }),
      candidate({ runId: 'eligible', workspaceId: 'ws_b', sequence: 3 }),
    ];

    expect(selectDispatchableCandidates(candidates, limits({ globalConcurrency: 2 })).map((item) => item.runId)).toEqual([
      'eligible',
    ]);
  });
});

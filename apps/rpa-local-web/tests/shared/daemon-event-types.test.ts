import { describe, expect, it } from 'vitest';
import {
  isDaemonArtifactFinalizedEvent,
  isDaemonEndEvent,
  isDaemonErrorEvent,
  isDaemonTextDeltaEvent,
} from '../../src/shared/daemon-event-types.js';

describe('daemon event type guards', () => {
  it('accepts text_delta events with a string delta', () => {
    const event: unknown = { type: 'text_delta', delta: 'hello' };

    expect(isDaemonTextDeltaEvent(event)).toBe(true);
    if (isDaemonTextDeltaEvent(event)) {
      expect(event.delta).toBe('hello');
    }
  });

  it('rejects malformed text_delta events', () => {
    expect(isDaemonTextDeltaEvent({ type: 'text_delta', delta: 42 })).toBe(false);
    expect(isDaemonTextDeltaEvent(null)).toBe(false);
  });

  it('accepts artifact_finalized events with a relative artifact path', () => {
    const event: unknown = {
      type: 'artifact_finalized',
      artifact: {
        id: 'artifact_1',
        runId: 'run_1',
        ruleId: 'required-rpa-flow-artifact',
        role: 'primary',
        relativePath: 'output/flow.dsl.json',
        fileName: 'flow.dsl.json',
        mimeType: 'application/json',
        size: 123,
        mtime: 1_234,
        sha256: 'abc',
      },
    };

    expect(isDaemonArtifactFinalizedEvent(event)).toBe(true);
    if (isDaemonArtifactFinalizedEvent(event)) {
      expect(event.artifact.relativePath).toBe('output/flow.dsl.json');
    }
  });

  it('rejects malformed artifact_finalized events', () => {
    expect(isDaemonArtifactFinalizedEvent({ type: 'artifact_finalized', artifact: null })).toBe(false);
    expect(isDaemonArtifactFinalizedEvent({ type: 'artifact_finalized', artifact: { relativePath: 12 } })).toBe(false);
  });

  it('accepts terminal end events with known daemon statuses', () => {
    expect(isDaemonEndEvent({ type: 'end', status: 'succeeded' })).toBe(true);
    expect(isDaemonEndEvent({ type: 'end', status: 'failed' })).toBe(true);
    expect(isDaemonEndEvent({ type: 'end' })).toBe(true);
  });

  it('rejects malformed end events', () => {
    expect(isDaemonEndEvent({ type: 'end', status: 10 })).toBe(false);
    expect(isDaemonEndEvent({ type: 'end', status: 'done' })).toBe(false);
  });

  it('accepts error events with optional code and details', () => {
    const event: unknown = { type: 'error', message: 'boom', code: 'RUN_FAILED', details: { exitCode: 1 } };

    expect(isDaemonErrorEvent(event)).toBe(true);
    if (isDaemonErrorEvent(event)) {
      expect(event.message).toBe('boom');
      expect(event.code).toBe('RUN_FAILED');
    }
  });

  it('rejects malformed error events', () => {
    expect(isDaemonErrorEvent({ type: 'error', message: 500 })).toBe(false);
    expect(isDaemonErrorEvent({ type: 'error', message: 'boom', code: 500 })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { createClaudeStreamHandler } from '../claude-stream.js';
import type { RunEvent } from '../run-events.js';

function collectEvents() {
  const events: RunEvent[] = [];
  const handler = createClaudeStreamHandler((event) => events.push(event));

  return { events, handler };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('Claude stream parser', () => {
  it('emits status with model and session id for system init', () => {
    const { events, handler } = collectEvents();

    handler.feed(
      jsonLine({
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-5',
        session_id: 'session-123',
      }),
    );

    expect(events).toEqual([
      {
        type: 'status',
        label: 'initializing',
        model: 'claude-sonnet-4-5',
        sessionId: 'session-123',
      },
    ]);
  });

  it('emits text_delta from stream_event content block deltas', () => {
    const { events, handler } = collectEvents();

    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-1' },
        },
      }),
    );
    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
      }),
    );

    expect(events).toEqual([{ type: 'text_delta', delta: 'hello' }]);
  });

  it('emits final assistant wrapper text when no streamed text was seen', () => {
    const { events, handler } = collectEvents();

    handler.feed(
      jsonLine({
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: 'fallback text' }],
        },
      }),
    );

    expect(events).toEqual([{ type: 'text_delta', delta: 'fallback text' }]);
  });

  it('does not duplicate final assistant wrapper text after streamed text', () => {
    const { events, handler } = collectEvents();

    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-1' },
        },
      }),
    );
    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
      }),
    );
    handler.feed(
      jsonLine({
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: 'hello' }],
        },
      }),
    );

    expect(events).toEqual([{ type: 'text_delta', delta: 'hello' }]);
  });

  it('emits thinking_start and thinking_delta', () => {
    const { events, handler } = collectEvents();

    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
      }),
    );
    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'considering' },
        },
      }),
    );

    expect(events).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', delta: 'considering' },
    ]);
  });

  it('merges partial input_json_delta chunks into one tool_use', () => {
    const { events, handler } = collectEvents();

    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-1' },
        },
      }),
    );
    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        },
      }),
    );
    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"file_' },
        },
      }),
    );
    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: 'path":"README.md"}' },
        },
      }),
    );
    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      }),
    );

    expect(events).toEqual([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: 'README.md' },
      },
    ]);
  });

  it('suppresses duplicate final-wrapper tool_use after streamed tool input emitted', () => {
    const { events, handler } = collectEvents();

    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-1' },
        },
      }),
    );
    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        },
      }),
    );
    handler.feed(
      jsonLine({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"README.md"}' },
        },
      }),
    );
    handler.feed(jsonLine({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));
    handler.feed(
      jsonLine({
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
        },
      }),
    );

    expect(events).toEqual([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: 'README.md' },
      },
    ]);
  });

  it('emits tool_result from user wrappers', () => {
    const { events, handler } = collectEvents();

    handler.feed(
      jsonLine({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [{ type: 'text', text: 'done' }],
              is_error: true,
            },
          ],
        },
      }),
    );

    expect(events).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: 'done',
        isError: true,
      },
    ]);
  });

  it('emits usage with cost, duration, and stop reason for result events', () => {
    const { events, handler } = collectEvents();

    handler.feed(
      jsonLine({
        type: 'result',
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.25,
        duration_ms: 1234,
        stop_reason: 'end_turn',
      }),
    );

    expect(events).toEqual([
      {
        type: 'usage',
        usage: { input_tokens: 10, output_tokens: 5 },
        costUsd: 0.25,
        durationMs: 1234,
        stopReason: 'end_turn',
      },
    ]);
  });

  it('emits capped raw events for invalid JSONL instead of throwing', () => {
    const { events, handler } = collectEvents();
    const invalidLine = `{"type":${'x'.repeat(2_500)}`;

    expect(() => handler.feed(`${invalidLine}\n`)).not.toThrow();

    expect(events).toEqual([{ type: 'raw', line: invalidLine.slice(0, 2_000) }]);
  });

  it('flush drains a trailing JSON line without a final newline', () => {
    const { events, handler } = collectEvents();

    handler.feed(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: 'last line' }],
        },
      }),
    );
    handler.flush();

    expect(events).toEqual([{ type: 'text_delta', delta: 'last line' }]);
  });
});

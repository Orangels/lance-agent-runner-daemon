import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/core/run-events.js';
import {
  filterRunEvent,
  filterRunEvents,
  resolveEventVisibility,
} from '../../src/core/event-visibility.js';

const allEvents: RunEvent[] = [
  { type: 'status', label: 'running' },
  { type: 'assistant_message_start', messageId: 'msg_1' },
  { type: 'text_delta', delta: 'hello' },
  { type: 'usage', usage: { input_tokens: 1 }, costUsd: null, durationMs: 10, stopReason: null },
  { type: 'error', message: 'failed', code: 'CLAUDE_CLI_FAILED' },
  { type: 'warning', message: 'degraded', code: 'RUN_LOG_WRITE_FAILED' },
  {
    type: 'artifact_finalized',
    artifact: {
      id: 'artifact_1',
      runId: 'run_1',
      ruleId: 'report-docx',
      role: 'primary',
      relativePath: 'output/report.docx',
      fileName: 'report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 123,
      mtime: 1770000000000,
      sha256: 'abc123',
    },
  },
  { type: 'end' },
  { type: 'thinking_start' },
  { type: 'thinking_delta', delta: 'thinking' },
  { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'README.md' } },
  { type: 'tool_result', toolUseId: 'tool_1', content: 'contents', isError: false },
  { type: 'stderr', text: 'stderr output' },
  { type: 'raw', line: '{"type":"raw"}' },
];

describe('event visibility filtering', () => {
  it('quiet includes status, text_delta, usage, error, warning, artifact_finalized, and end', () => {
    expect(filterRunEvents(allEvents, 'quiet').map((event) => event.type)).toEqual([
      'status',
      'assistant_message_start',
      'text_delta',
      'usage',
      'error',
      'warning',
      'artifact_finalized',
      'end',
    ]);
  });

  it('normal includes thinking and tool use while excluding tool results, stderr, and raw', () => {
    expect(filterRunEvents(allEvents, 'normal').map((event) => event.type)).toEqual([
      'status',
      'assistant_message_start',
      'text_delta',
      'usage',
      'error',
      'warning',
      'artifact_finalized',
      'end',
      'thinking_start',
      'thinking_delta',
      'tool_use',
    ]);
  });

  it('debug includes capped stderr and raw only when the client can read debug events', () => {
    const longText = 'x'.repeat(2_100);
    const events: RunEvent[] = [
      { type: 'tool_result', toolUseId: 'tool_1', content: 'hidden tool output', isError: false },
      { type: 'stderr', text: longText },
      { type: 'raw', line: longText },
    ];

    const allowedVisibility = resolveEventVisibility({
      client: { canReadDebugEvents: true },
      profile: { eventVisibility: 'debug' },
      request: { eventVisibility: 'debug' },
    });
    const blockedVisibility = resolveEventVisibility({
      client: { canReadDebugEvents: false },
      profile: { eventVisibility: 'debug' },
      request: { eventVisibility: 'debug' },
    });

    expect(allowedVisibility).toBe('debug');
    expect(filterRunEvents(events, allowedVisibility)).toEqual([
      { type: 'stderr', text: longText.slice(0, 2_000) },
      { type: 'raw', line: longText.slice(0, 2_000) },
    ]);
    expect(blockedVisibility).toBe('normal');
    expect(filterRunEvents(events, blockedVisibility)).toEqual([]);
  });

  it('downgrades request debug when profile visibility is normal', () => {
    expect(
      resolveEventVisibility({
        client: { canReadDebugEvents: true },
        profile: { eventVisibility: 'normal' },
        request: { eventVisibility: 'debug' },
      }),
    ).toBe('normal');
  });

  it('downgrades request debug when client cannot read debug events', () => {
    expect(
      resolveEventVisibility({
        client: { canReadDebugEvents: false },
        profile: { eventVisibility: 'debug' },
        request: { eventVisibility: 'debug' },
      }),
    ).toBe('normal');
  });

  it('does not mutate input events while capping debug payloads', () => {
    const input: RunEvent = { type: 'stderr', text: 'x'.repeat(2_100) };

    const output = filterRunEvent(input, 'debug');

    expect(input).toEqual({ type: 'stderr', text: 'x'.repeat(2_100) });
    expect(output).toEqual({ type: 'stderr', text: 'x'.repeat(2_000) });
    expect(output).not.toBe(input);
  });

  it('redacts absolute paths from filtered event payloads without mutating nested input', () => {
    const input: RunEvent = {
      type: 'tool_use',
      id: 'tool_1',
      name: 'Read',
      input: { file_path: '/home/orangels/ls_dev/lance-agent-runner-daemon/work/secret.txt' },
    };

    const output = filterRunEvent(input, 'normal');

    expect(input).toEqual({
      type: 'tool_use',
      id: 'tool_1',
      name: 'Read',
      input: { file_path: '/home/orangels/ls_dev/lance-agent-runner-daemon/work/secret.txt' },
    });
    expect(output).toEqual({
      type: 'tool_use',
      id: 'tool_1',
      name: 'Read',
      input: { file_path: '[redacted-path]' },
    });
    expect(output).not.toBe(input);
    expect((output as Extract<RunEvent, { type: 'tool_use' }>).input).not.toBe(input.input);
  });

  it('filters tool result content from public event payloads', () => {
    const output = filterRunEvent(
      {
        type: 'tool_result',
        toolUseId: 'tool_1',
        content: 'authorization: Bearer secret-token\ncookie=session=secret-cookie',
        isError: true,
      },
      'normal',
    );

    expect(output).toBeNull();
  });

  it('filters tool result content even for debug visibility', () => {
    expect(
      filterRunEvent(
        { type: 'tool_result', toolUseId: 'tool_1', content: 'debug tool output', isError: false },
        'debug',
      ),
    ).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyRunEventToMessage,
  createAssistantMessage,
  reconcileMessagesWithRunDetail,
} from '../run-event-reducer.js';
import type { DemoChatMessage } from '../chat-types.js';

describe('applyRunEventToMessage', () => {
  it('aggregates text deltas into assistant content', () => {
    const initial = createAssistantMessage({ id: 'm1', runId: 'run_1', runMode: 'generate-sse' });

    const first = applyRunEventToMessage(initial, { id: '1', event: { type: 'text_delta', delta: 'Hello' } });
    const second = applyRunEventToMessage(first, { id: '2', event: { type: 'text_delta', delta: ' world' } });

    expect(second.content).toBe('Hello world');
    expect(second.lastRunEventId).toBe('2');
    expect(second.events).toHaveLength(2);
  });

  it('adds artifact events to the assistant artifact list', () => {
    const initial = createAssistantMessage({ id: 'm1', runId: 'run_1', runMode: 'generate-sse' });

    const updated = applyRunEventToMessage(initial, {
      id: '3',
      event: {
        type: 'artifact_finalized',
        artifact: {
          id: 'artifact_1',
          runId: 'run_1',
          ruleId: 'report-docx',
          role: 'report',
          relativePath: 'output/report.docx',
          fileName: 'report.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 42,
          mtime: 123,
          sha256: 'abc',
        },
      },
    });

    expect(updated.artifacts ?? []).toHaveLength(1);
    expect(updated.artifacts?.[0]?.fileName).toBe('report.docx');
  });

  it('sets error and terminal status events', () => {
    const initial = createAssistantMessage({ id: 'm1', runId: 'run_1', runMode: 'generate-sse' });

    const failed = applyRunEventToMessage(initial, {
      id: '4',
      event: { type: 'error', code: 'CLAUDE_CLI_FAILED', message: 'Claude failed' },
    });
    const ended = applyRunEventToMessage(failed, {
      id: '5',
      event: { type: 'end', status: 'failed' },
    });

    expect(ended.error).toEqual({ code: 'CLAUDE_CLI_FAILED', message: 'Claude failed' });
    expect(ended.runStatus).toBe('failed');
    expect(ended.endedAt).toEqual(expect.any(Number));
  });
});

describe('reconcileMessagesWithRunDetail', () => {
  it('updates the local assistant message by run id without appending daemon draft rows', () => {
    const messages: DemoChatMessage[] = [
      {
        id: 'local-user',
        role: 'user',
        content: 'Generate',
        createdAt: 1,
        runMode: 'generate-poll',
      },
      createAssistantMessage({ id: 'local-assistant', runId: 'run_1', runMode: 'generate-poll' }),
    ];

    const updated = reconcileMessagesWithRunDetail(messages, {
      run: {
        id: 'run_1',
        workspaceId: 'ws_1',
        profileId: 'report-docx',
        kind: 'generate',
        skillId: 'report-gen',
        status: 'succeeded',
        lastRunEventId: '9',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        createdAt: 1,
        updatedAt: 3,
      },
      messages: [
        {
          id: 'daemon-user',
          role: 'user',
          content: 'Generate',
          events: null,
          runStatus: null,
          lastRunEventId: null,
          startedAt: null,
          endedAt: null,
          position: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'daemon-assistant',
          role: 'assistant',
          content: 'Durable report text',
          events: [{ type: 'end', status: 'succeeded' }],
          runStatus: 'succeeded',
          lastRunEventId: '9',
          startedAt: 2,
          endedAt: 3,
          position: 2,
          createdAt: 1,
          updatedAt: 3,
        },
      ],
    });

    expect(updated).toHaveLength(2);
    expect(updated[1]).toMatchObject({
      id: 'local-assistant',
      content: 'Durable report text',
      runId: 'run_1',
      runStatus: 'succeeded',
      lastRunEventId: '9',
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyRunEventToMessage,
  applyRunEventToMessages,
  attachArtifactsToLastAssistantMessage,
  createAssistantMessage,
  reconcileMessagesWithRunDetail,
} from '../../src/chat/run-event-reducer.js';
import type { DemoArtifact, DemoChatMessage } from '../../src/chat/chat-types.js';

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
          role: 'primary',
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

describe('applyRunEventToMessages', () => {
  it('reuses the initial assistant placeholder when status events arrive before the first message start', () => {
    const initial = [
      createAssistantMessage({ id: 'local-assistant', runId: 'run_1', runMode: 'generate-sse' }),
    ];

    const withStatus = applyRunEventToMessages(
      initial,
      'run_1',
      { id: '1', event: { type: 'status', label: 'running' } },
      () => 'new-assistant',
    );
    const withStart = applyRunEventToMessages(
      withStatus,
      'run_1',
      { id: '2', event: { type: 'assistant_message_start', messageId: 'claude_msg_1' } },
      () => 'new-assistant',
    );
    const withText = applyRunEventToMessages(
      withStart,
      'run_1',
      { id: '3', event: { type: 'text_delta', delta: 'First.' } },
      () => 'new-assistant',
    );

    expect(withText).toHaveLength(1);
    expect(withText[0]).toMatchObject({
      id: 'local-assistant',
      content: 'First.',
      runStatus: 'running',
    });
  });

  it('starts a new local assistant message for later assistant message starts', () => {
    let nextId = 1;
    const initial = [
      {
        ...createAssistantMessage({ id: 'local-assistant', runId: 'run_1', runMode: 'generate-sse' }),
        content: 'First.',
      },
    ];

    const updated = applyRunEventToMessages(
      initial,
      'run_1',
      { id: '4', event: { type: 'assistant_message_start', messageId: 'claude_msg_2' } },
      () => `new-assistant-${nextId++}`,
    );

    expect(updated.map((message) => message.id)).toEqual(['local-assistant', 'new-assistant-1']);
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
          thinkingContent: '',
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
          thinkingContent: '',
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

  it('replaces one local assistant placeholder with multiple durable assistant messages', () => {
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
          thinkingContent: '',
          events: null,
          runStatus: null,
          lastRunEventId: null,
          startedAt: null,
          endedAt: null,
          position: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'daemon-assistant-1',
          role: 'assistant',
          content: 'First assistant turn.',
          thinkingContent: '',
          events: [{ type: 'text_delta', delta: 'First assistant turn.' }],
          runStatus: 'succeeded',
          lastRunEventId: '4',
          startedAt: 2,
          endedAt: 3,
          position: 1,
          createdAt: 1,
          updatedAt: 3,
        },
        {
          id: 'daemon-assistant-2',
          role: 'assistant',
          content: 'Second assistant turn.',
          thinkingContent: '',
          events: [{ type: 'text_delta', delta: 'Second assistant turn.' }],
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

    expect(updated.map((message) => message.content)).toEqual([
      'Generate',
      'First assistant turn.',
      'Second assistant turn.',
    ]);
    expect(updated.slice(1).map((message) => message.id)).toEqual(['local-assistant', 'daemon-assistant-2']);
  });

  it('attaches run errors only to the last durable assistant message', () => {
    const messages: DemoChatMessage[] = [
      createAssistantMessage({ id: 'local-assistant', runId: 'run_1', runMode: 'generate-poll' }),
    ];

    const updated = reconcileMessagesWithRunDetail(messages, {
      run: {
        id: 'run_1',
        workspaceId: 'ws_1',
        profileId: 'report-docx',
        kind: 'generate',
        skillId: 'report-gen',
        status: 'failed',
        lastRunEventId: '9',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        createdAt: 1,
        updatedAt: 3,
        errorCode: 'RUN_TIMEOUT',
        errorMessage: 'Run exceeded total timeout.',
      },
      messages: [
        {
          id: 'daemon-assistant-1',
          role: 'assistant',
          content: 'First assistant turn.',
          thinkingContent: '',
          events: [{ type: 'text_delta', delta: 'First assistant turn.' }],
          runStatus: 'failed',
          lastRunEventId: '4',
          startedAt: 2,
          endedAt: 3,
          position: 1,
          createdAt: 1,
          updatedAt: 3,
        },
        {
          id: 'daemon-assistant-2',
          role: 'assistant',
          content: 'Second assistant turn.',
          thinkingContent: '',
          events: [{ type: 'text_delta', delta: 'Second assistant turn.' }],
          runStatus: 'failed',
          lastRunEventId: '9',
          startedAt: 2,
          endedAt: 3,
          position: 2,
          createdAt: 1,
          updatedAt: 3,
        },
      ],
    });

    expect(updated.map((message) => message.error?.code ?? null)).toEqual([null, 'RUN_TIMEOUT']);
  });
});

describe('attachArtifactsToLastAssistantMessage', () => {
  it('attaches artifacts only to the last assistant message for the run', () => {
    const first = createAssistantMessage({ id: 'assistant-1', runId: 'run_1', runMode: 'generate-sse' });
    const second = createAssistantMessage({ id: 'assistant-2', runId: 'run_1', runMode: 'generate-sse' });
    const artifact: DemoArtifact = {
      id: 'artifact_1',
      runId: 'run_1',
      ruleId: 'report-docx',
      role: 'primary',
      relativePath: 'output/report.docx',
      fileName: 'report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 42,
      mtime: 123,
      sha256: 'abc',
    };

    const updated = attachArtifactsToLastAssistantMessage([first, second], 'run_1', [artifact]);

    expect(updated[0]?.artifacts).toEqual([]);
    expect(updated[1]?.artifacts).toEqual([artifact]);
  });
});

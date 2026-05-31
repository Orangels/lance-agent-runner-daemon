import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssistantMessage } from '../AssistantMessage.js';
import type { DemoChatMessage } from '../../chat/chat-types.js';

describe('AssistantMessage', () => {
  it('renders assistant text, tool events, errors, and artifacts', () => {
    const message: DemoChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'Report ready.',
      createdAt: 1,
      runId: 'run_1',
      runStatus: 'failed',
      error: { code: 'CLAUDE_CLI_FAILED', message: 'Claude failed' },
      events: [
        { type: 'status', label: 'running' },
        { type: 'tool_use', name: 'Read', id: 'tool_1', input: { file: 'input/report.docx' } },
        { type: 'tool_result', toolUseId: 'tool_1', content: 'ok', isError: false },
        { type: 'end', status: 'failed' },
      ],
      artifacts: [
        {
          id: 'artifact_1',
          runId: 'run_1',
          workspaceId: 'ws_1',
          ruleId: 'report-docx',
          role: 'report',
          relativePath: 'output/report.docx',
          fileName: 'report.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 1024,
          mtime: 1,
          sha256: 'abc',
        },
      ],
    };

    render(<AssistantMessage message={message} onDownloadArtifact={() => undefined} />);

    expect(screen.getByText('Report ready.')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Claude failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download report\.docx/i })).toBeInTheDocument();
  });

  it('renders streamed thinking as one block before assistant text', () => {
    const message: DemoChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'Final answer.',
      createdAt: 1,
      runId: 'run_1',
      runStatus: 'running',
      events: [
        { type: 'thinking_start' },
        { type: 'thinking_delta', delta: 'First ' },
        { type: 'thinking_delta', delta: 'second.' },
        { type: 'text_delta', delta: 'Final answer.' },
      ],
      artifacts: [],
    };

    render(<AssistantMessage message={message} onDownloadArtifact={() => undefined} />);

    expect(screen.getAllByText('Thinking')).toHaveLength(1);
    const thinkingText = screen.getByText('First second.');
    const assistantText = screen.getByText('Final answer.');

    expect(thinkingText.closest('.thinking-block')).not.toBeNull();
    expect(
      thinkingText
        .closest('.thinking-block')
        ?.compareDocumentPosition(assistantText) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

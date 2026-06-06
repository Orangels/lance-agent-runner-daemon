import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage.js';
import type { DemoChatMessage } from '../../src/chat/chat-types.js';

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
          role: 'primary',
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

  it('shows the agent waiting placeholder only for empty active assistant messages', () => {
    const message: DemoChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: 1,
      runId: 'run_1',
      runStatus: 'running',
      events: [{ type: 'status', label: 'running' }],
      artifacts: [],
    };

    render(<AssistantMessage message={message} onDownloadArtifact={() => undefined} />);

    expect(screen.getByText('Waiting for Agent...')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for Claude Code...')).not.toBeInTheDocument();
  });

  it('does not show the waiting placeholder when tool or thinking content is present', () => {
    const withTool: DemoChatMessage = {
      id: 'tool-message',
      role: 'assistant',
      content: '',
      createdAt: 1,
      runId: 'run_1',
      runStatus: 'running',
      events: [
        { type: 'status', label: 'running' },
        { type: 'tool_use', name: 'Bash', id: 'tool_1', input: { command: 'ls' } },
      ],
      artifacts: [],
    };
    const withThinking: DemoChatMessage = {
      id: 'thinking-message',
      role: 'assistant',
      content: '',
      createdAt: 2,
      runId: 'run_1',
      runStatus: 'running',
      events: [
        { type: 'thinking_start' },
        { type: 'thinking_delta', delta: 'Planning.' },
      ],
      artifacts: [],
    };

    const { rerender } = render(<AssistantMessage message={withTool} onDownloadArtifact={() => undefined} />);

    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for Agent...')).not.toBeInTheDocument();

    rerender(<AssistantMessage message={withThinking} onDownloadArtifact={() => undefined} />);

    expect(screen.getByText('Planning.')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for Agent...')).not.toBeInTheDocument();
  });
});

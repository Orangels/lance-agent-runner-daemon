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
});

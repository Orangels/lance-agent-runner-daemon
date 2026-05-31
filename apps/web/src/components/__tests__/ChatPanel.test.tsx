import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../ChatPanel.js';
import type { DemoChatMessage } from '../../chat/chat-types.js';

describe('ChatPanel', () => {
  it('shows starter prompts and fills the composer when clicked', async () => {
    const user = userEvent.setup();

    render(
      <ChatPanel
        activeRunId={null}
        artifacts={[]}
        messages={[]}
        onCancelRun={() => undefined}
        onClear={() => undefined}
        onDownloadArtifact={() => undefined}
        onFilesSelected={() => undefined}
        onRefreshRun={() => undefined}
        onSend={() => undefined}
        runStatus="idle"
        selectedFiles={[]}
        workspaceKey={null}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Generate report with SSE/i }));

    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toContain('Generate');
  });

  it('renders user and assistant messages and submits composer payloads', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const messages: DemoChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Generate it', createdAt: 1, runMode: 'generate-sse' },
      { id: 'a1', role: 'assistant', content: 'Done', createdAt: 2, runId: 'run_1', runStatus: 'succeeded' },
    ];

    render(
      <ChatPanel
        activeRunId={null}
        artifacts={[]}
        messages={messages}
        onCancelRun={() => undefined}
        onClear={() => undefined}
        onDownloadArtifact={() => undefined}
        onFilesSelected={() => undefined}
        onRefreshRun={() => undefined}
        onSend={onSend}
        runStatus="succeeded"
        selectedFiles={[]}
        workspaceKey="demo/user/project"
      />,
    );

    await user.type(screen.getByLabelText('Prompt'), 'Revise the wording');
    await user.click(screen.getByRole('radio', { name: 'Revise' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByText('Generate it')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(onSend).toHaveBeenCalledWith({ prompt: 'Revise the wording', workflowMode: 'revise' });
  });
});

import { RefreshCw, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { SelectedWorkspaceFile, ChatSendRequest } from '../app-types.js';
import type { DemoArtifact, DemoChatMessage, WorkflowMode } from '../chat/chat-types.js';
import type { RunStatus } from '../api/types.js';
import { ArtifactList } from './ArtifactList.js';
import { AssistantMessage } from './AssistantMessage.js';
import { ChatComposer } from './ChatComposer.js';
import { StatusPill } from './StatusPill.js';
import { UserMessage } from './UserMessage.js';

interface ChatPanelProps {
  activeRunId: string | null;
  artifacts: DemoArtifact[];
  messages: DemoChatMessage[];
  runStatus: RunStatus | 'idle' | 'creating workspace' | 'uploading';
  selectedFiles: SelectedWorkspaceFile[];
  workflowMode?: WorkflowMode;
  workspaceKey: string | null;
  onCancelRun: () => void;
  onClear: () => void;
  onDownloadArtifact: (artifact: DemoArtifact) => void;
  onFilesSelected: (files: FileList) => void;
  onRefreshRun: () => void;
  onSend: (request: ChatSendRequest) => void;
  onWorkflowModeChange?: (workflowMode: WorkflowMode) => void;
}

const starters: Array<{ title: string; mode: WorkflowMode; prompt: string }> = [
  {
    title: 'Generate report with SSE',
    mode: 'generate-sse',
    prompt: 'Generate a structured report from the uploaded source document. Include an executive summary and clear section headings.',
  },
  {
    title: 'Generate report without SSE',
    mode: 'generate-poll',
    prompt: 'Generate the same report without opening the live event stream, then reconcile from durable run detail.',
  },
  {
    title: 'Revise current report',
    mode: 'revise',
    prompt: 'Revise the current report: improve clarity, tighten the executive summary, and preserve the document structure.',
  },
];

export function ChatPanel({
  activeRunId,
  artifacts,
  messages,
  runStatus,
  selectedFiles,
  workflowMode,
  workspaceKey,
  onCancelRun,
  onClear,
  onDownloadArtifact,
  onFilesSelected,
  onRefreshRun,
  onSend,
  onWorkflowModeChange,
}: ChatPanelProps) {
  const [draftSeed, setDraftSeed] = useState<ChatComposerPropsSeed | null>(null);
  const busy = activeRunId !== null && (runStatus === 'queued' || runStatus === 'running' || runStatus === 'uploading');

  return (
    <section className="chat-panel">
      <header className="chat-header">
        <div>
          <span className="eyebrow">Workspace</span>
          <strong>{workspaceKey ?? 'No workspace'}</strong>
        </div>
        <StatusPill status={runStatus} />
        <div className="chat-header-actions">
          <button type="button" className="icon-btn" onClick={onRefreshRun} aria-label="Refresh run detail">
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" onClick={onCancelRun} disabled={!activeRunId} aria-label="Cancel run">
            <XCircle size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" onClick={onClear} aria-label="Clear local chat">
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="chat-log">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <h2>Start a daemon run</h2>
            <p>Pick a flow, upload files if needed, and use the chat log as the business-side integration trace.</p>
            <div className="chat-examples">
              {starters.map((starter, index) => (
                <button
                  type="button"
                  className="chat-example"
                  key={starter.mode}
                  onClick={() => setDraftSeed({ prompt: starter.prompt, workflowMode: starter.mode, nonce: index + Date.now() })}
                >
                  <strong>{starter.title}</strong>
                  <span>{starter.prompt}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) =>
            message.role === 'user' ? (
              <UserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessage key={message.id} message={message} onDownloadArtifact={onDownloadArtifact} />
            ),
          )
        )}
      </div>
      <ArtifactList artifacts={artifacts} onDownloadArtifact={onDownloadArtifact} />
      <ChatComposer
        busy={busy}
        draftSeed={draftSeed}
        onFilesSelected={onFilesSelected}
        onSend={onSend}
        onStop={onCancelRun}
        onWorkflowModeChange={onWorkflowModeChange}
        selectedFiles={selectedFiles}
        workflowMode={workflowMode}
      />
    </section>
  );
}

type ChatComposerPropsSeed = {
  prompt: string;
  workflowMode: WorkflowMode;
  nonce: number;
};

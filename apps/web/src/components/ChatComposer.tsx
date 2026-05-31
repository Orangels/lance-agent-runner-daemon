import { Paperclip, Send, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SelectedWorkspaceFile, ChatSendRequest } from '../app-types.js';
import type { WorkflowMode } from '../chat/chat-types.js';

interface ChatComposerProps {
  busy: boolean;
  draftSeed?: {
    prompt: string;
    workflowMode: WorkflowMode;
    nonce: number;
  } | null;
  workflowMode?: WorkflowMode;
  selectedFiles: SelectedWorkspaceFile[];
  onFilesSelected: (files: FileList) => void;
  onWorkflowModeChange?: (workflowMode: WorkflowMode) => void;
  onSend: (request: ChatSendRequest) => void;
  onStop: () => void;
}

export function ChatComposer({
  busy,
  draftSeed,
  workflowMode: controlledWorkflowMode,
  selectedFiles,
  onFilesSelected,
  onWorkflowModeChange,
  onSend,
  onStop,
}: ChatComposerProps) {
  const [prompt, setPrompt] = useState('');
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>('generate-sse');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!draftSeed) {
      return;
    }
    setPrompt(draftSeed.prompt);
    updateWorkflowMode(draftSeed.workflowMode);
  }, [draftSeed]);

  useEffect(() => {
    if (controlledWorkflowMode) {
      setWorkflowMode(controlledWorkflowMode);
    }
  }, [controlledWorkflowMode]);

  function updateWorkflowMode(next: WorkflowMode) {
    setWorkflowMode(next);
    onWorkflowModeChange?.(next);
  }

  function submit() {
    const trimmed = prompt.trim();
    if (!trimmed || busy) {
      return;
    }
    onSend({ prompt: trimmed, workflowMode });
    setPrompt('');
  }

  return (
    <div className="composer">
      <div className="composer-shell">
        <div className="workflow-control" role="radiogroup" aria-label="Workflow">
          <WorkflowOption label="Generate + SSE" value="generate-sse" selected={workflowMode} onChange={updateWorkflowMode} />
          <WorkflowOption label="Generate + Poll" value="generate-poll" selected={workflowMode} onChange={updateWorkflowMode} />
          <WorkflowOption label="Revise" value="revise" selected={workflowMode} onChange={updateWorkflowMode} />
        </div>
        <textarea
          aria-label="Prompt"
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the report to generate, or how to revise the current report..."
          rows={4}
          value={prompt}
        />
        {selectedFiles.length > 0 ? (
          <div className="composer-files">
            {selectedFiles.map((file) => (
              <span key={file.id}>{file.targetPath}</span>
            ))}
          </div>
        ) : null}
        <div className="composer-row">
          <input
            aria-label="Attach files"
            hidden
            multiple
            onChange={(event) => {
              if (event.target.files) {
                onFilesSelected(event.target.files);
              }
              event.target.value = '';
            }}
            ref={fileInputRef}
            type="file"
          />
          <button type="button" className="icon-btn" onClick={() => fileInputRef.current?.click()} aria-label="Attach">
            <Paperclip size={16} aria-hidden="true" />
          </button>
          <span className="composer-spacer" />
          {busy ? (
            <button type="button" className="composer-send stop" onClick={onStop} aria-label="Stop">
              <Square size={16} aria-hidden="true" />
              Stop
            </button>
          ) : (
            <button type="button" className="composer-send" onClick={submit} disabled={!prompt.trim()} aria-label="Send">
              <Send size={16} aria-hidden="true" />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkflowOption({
  label,
  value,
  selected,
  onChange,
}: {
  label: string;
  value: WorkflowMode;
  selected: WorkflowMode;
  onChange: (value: WorkflowMode) => void;
}) {
  return (
    <label className={selected === value ? 'workflow-option active' : 'workflow-option'}>
      <input checked={selected === value} name="workflow" onChange={() => onChange(value)} type="radio" />
      {label}
    </label>
  );
}

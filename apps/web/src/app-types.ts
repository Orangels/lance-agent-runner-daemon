import type { WorkflowMode } from './chat/chat-types.js';

export interface SelectedWorkspaceFile {
  id: string;
  file: File;
  targetPath: string;
}

export interface ChatSendRequest {
  prompt: string;
  workflowMode: WorkflowMode;
}

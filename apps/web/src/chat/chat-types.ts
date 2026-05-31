import type { PublicArtifact, RunStatus } from '../api/types.js';
import type { StreamedDaemonEvent } from '../api/sse-stream.js';

export type DemoChatRole = 'user' | 'assistant';

export type WorkflowMode = 'generate-sse' | 'generate-poll' | 'revise';

export interface DemoArtifact extends Omit<PublicArtifact, 'workspaceId'> {
  workspaceId?: string;
}

export interface DemoRunEvent extends StreamedDaemonEvent {
  id?: string;
}

export interface DemoChatMessage {
  id: string;
  role: DemoChatRole;
  content: string;
  createdAt: number;
  runId?: string;
  runMode?: WorkflowMode;
  runStatus?: RunStatus;
  events?: DemoRunEvent[];
  artifacts?: DemoArtifact[];
  lastRunEventId?: string;
  endedAt?: number;
  error?: {
    code?: string;
    message: string;
  };
}

import { useMemo, useRef, useState } from 'react';
import type {
  EventVisibility,
  PublicArtifact,
  PublicProfile,
  RunDetailResponse,
  RunStatus,
  RunStatusResponse,
  WorkspaceIdentity,
} from './api/types.js';
import { DaemonApiError, DaemonClient } from './api/daemon-client.js';
import { fetchArtifactDownload, triggerBrowserDownload } from './api/download.js';
import { streamRunEvents } from './api/sse-stream.js';
import type { ChatSendRequest, SelectedWorkspaceFile } from './app-types.js';
import type { DemoArtifact, DemoChatMessage, WorkflowMode } from './chat/chat-types.js';
import {
  applyRunEventToMessages,
  attachArtifactsToLastAssistantMessage,
  createAssistantMessage,
  reconcileMessagesWithRunDetail,
} from './chat/run-event-reducer.js';
import { pollRunStatus } from './chat/run-polling.js';
import { ChatPanel } from './components/ChatPanel.js';
import { ConnectionPanel } from './components/ConnectionPanel.js';
import { WorkspacePanel } from './components/WorkspacePanel.js';
import { isSafeWorkspaceSegment } from './components/workspace-validation.js';

export function App() {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [healthStatus, setHealthStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [profiles, setProfiles] = useState<PublicProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [model, setModel] = useState('');
  const [skillId, setSkillId] = useState('');
  const [artifactRuleIds, setArtifactRuleIds] = useState<string[]>([]);
  const [eventVisibility, setEventVisibility] = useState<EventVisibility>('normal');
  const [workspaceIdentity, setWorkspaceIdentity] = useState<WorkspaceIdentity>({
    originId: 'demo',
    userId: 'user_001',
    projectId: 'project_001',
  });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<SelectedWorkspaceFile[]>([]);
  const [messages, setMessages] = useState<DemoChatMessage[]>([]);
  const [artifacts, setArtifacts] = useState<DemoArtifact[]>([]);
  const [runStatus, setRunStatus] = useState<RunStatus | 'idle' | 'creating workspace' | 'uploading'>('idle');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>('generate-sse');
  const abortRef = useRef<AbortController | null>(null);
  const cancelingRunIdRef = useRef<string | null>(null);

  const client = useMemo(() => new DaemonClient({ baseUrl, apiKey }), [apiKey, baseUrl]);

  async function checkHealth() {
    setHealthStatus('checking');
    try {
      await client.getHealth();
      setHealthStatus('ok');
    } catch {
      setHealthStatus('error');
    }
  }

  async function loadProfiles() {
    try {
      const response = await client.getProfiles();
      setProfiles(response.profiles);
      if (response.profiles[0]) {
        applyProfile(response.profiles[0]);
      }
    } catch (error) {
      appendLocalError(error);
    }
  }

  function applyProfile(profile: PublicProfile) {
    setProfileId(profile.id);
    setModel(profile.defaultModel ?? profile.allowedModels[0] ?? '');
    setSkillId(profile.allowedSkillIds[0] ?? '');
    setArtifactRuleIds(profile.defaultArtifactRuleIds);
    setEventVisibility(profile.eventVisibility);
  }

  function selectProfile(nextProfileId: string) {
    const profile = profiles.find((item) => item.id === nextProfileId);
    if (profile) {
      applyProfile(profile);
    }
  }

  function addFiles(files: FileList) {
    setSelectedFiles((current) => [
      ...current,
      ...Array.from(files).map((file) => ({
        id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
        file,
        targetPath: `input/${file.name}`,
      })),
    ]);
  }

  function updateFileTargetPath(fileId: string, targetPath: string) {
    setSelectedFiles((current) => current.map((file) => (file.id === fileId ? { ...file, targetPath } : file)));
  }

  async function handleSend(request: ChatSendRequest) {
    setWorkflowMode(request.workflowMode);
    const userMessage: DemoChatMessage = {
      id: nextLocalId('user'),
      role: 'user',
      content: request.prompt,
      createdAt: Date.now(),
      runMode: request.workflowMode,
    };
    const assistantId = nextLocalId('assistant');
    const assistantMessage = createAssistantMessage({
      id: assistantId,
      runMode: request.workflowMode,
    });
    setMessages((current) => [...current, userMessage, assistantMessage]);

    try {
      if (!profileId) {
        throw new Error('Load and select a profile before starting a run.');
      }
      if (request.workflowMode === 'generate-sse' || request.workflowMode === 'generate-poll') {
        if (!skillId) {
          throw new Error('Select a skill for generate runs.');
        }
      }

      const currentWorkspace = await ensureWorkspace(request.workflowMode);
      await uploadSelectedFiles(currentWorkspace.workspaceId);
      const run = await client.createRun({
        profileId,
        workspaceId: currentWorkspace.workspaceId,
        kind: request.workflowMode === 'revise' ? 'revise' : 'generate',
        prompt: request.prompt,
        skillId: request.workflowMode === 'revise' ? undefined : skillId,
        model: model || undefined,
        artifactRuleIds,
        eventVisibility,
        metadata: {
          demoMode: request.workflowMode,
          previousRunId: request.workflowMode === 'revise' ? lastRunId : undefined,
        },
      });
      setActiveRunId(run.runId);
      setLastRunId(run.runId);
      setRunStatus(run.status);
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, runId: run.runId, runStatus: run.status } : message,
        ),
      );

      if (request.workflowMode === 'generate-poll') {
        await runGenerateByPolling(run.runId);
      } else {
        await runWithSse(run.runId);
      }
    } catch (error) {
      setRunStatus('failed');
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                error: formatError(error),
                runStatus: 'failed',
                endedAt: Date.now(),
              }
            : message,
        ),
      );
    } finally {
      setActiveRunId(null);
      abortRef.current = null;
    }
  }

  async function ensureWorkspace(mode: WorkflowMode): Promise<{ workspaceId: string; workspaceKey: string }> {
    if (workspaceId && workspaceKey) {
      return { workspaceId, workspaceKey };
    }
    if (!Object.values(workspaceIdentity).every(isSafeWorkspaceSegment)) {
      throw new Error('Workspace identity contains an unsafe path segment.');
    }
    if (mode === 'revise' && !workspaceId) {
      throw new Error('Run a generate flow first so revise can reuse an existing workspace.');
    }

    setRunStatus('creating workspace');
    const workspace = await client.createWorkspace({
      profileId,
      workspace: workspaceIdentity,
      metadata: { source: 'web-test-console' },
    });
    setWorkspaceId(workspace.workspaceId);
    setWorkspaceKey(workspace.workspaceKey);
    return workspace;
  }

  async function uploadSelectedFiles(currentWorkspaceId: string) {
    if (selectedFiles.length === 0) {
      return;
    }
    setRunStatus('uploading');
    const uploadedFileIds: string[] = [];
    for (const selectedFile of selectedFiles) {
      await client.uploadWorkspaceFile({
        workspaceId: currentWorkspaceId,
        file: selectedFile.file,
        targetPath: selectedFile.targetPath,
      });
      uploadedFileIds.push(selectedFile.id);
    }
    if (uploadedFileIds.length > 0) {
      setSelectedFiles((current) => current.filter((file) => !uploadedFileIds.includes(file.id)));
    }
  }

  async function runWithSse(runId: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    const result = await streamRunEvents({
      apiKey,
      baseUrl,
      runId,
      signal: controller.signal,
      onEvent: (record) => {
        setMessages((current) => applyRunEventToMessages(current, runId, record, () => nextLocalId('assistant')));
        if (record.event.type === 'end' && typeof record.event.status === 'string') {
          setRunStatus(record.event.status as RunStatus);
        }
      },
    });

    if (!result.ok && result.reason === 'aborted' && cancelingRunIdRef.current === runId) {
      return;
    }

    if (!result.ok || !result.terminal) {
      await reconcileRun(runId);
      return;
    }

    await reconcileRun(runId);
  }

  async function runGenerateByPolling(runId: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    const result = await pollRunStatus({
      runId,
      signal: controller.signal,
      getRunStatus: (id) => client.getRunStatus(id),
      onStatus: (status) => reconcileStatusInState(status),
    });
    if (!result.ok && result.reason === 'aborted' && cancelingRunIdRef.current === runId) {
      return;
    }
    await fetchArtifacts(runId);
  }

  async function reconcileRun(runId: string) {
    const detail = await client.getRunDetail(runId);
    reconcileDetailInState(detail);
    await fetchArtifacts(runId);
  }

  function reconcileDetailInState(detail: RunDetailResponse) {
    setRunStatus(detail.run.status);
    setMessages((current) => reconcileMessagesWithRunDetail(current, detail));
  }

  function reconcileStatusInState(status: RunStatusResponse) {
    setRunStatus(status.run.status);
    setMessages((current) =>
      current.map((message) =>
        message.runId === status.run.id
          ? {
              ...message,
              error:
                status.run.errorCode || status.run.errorMessage
                  ? {
                      code: status.run.errorCode ?? 'RUN_FAILED',
                      message: status.run.errorMessage ?? status.run.status,
                    }
                  : message.error,
              endedAt: status.run.finishedAt ?? message.endedAt,
              runStatus: status.run.status,
            }
          : message,
      ),
    );
  }

  async function fetchArtifacts(runId: string) {
    const response = await client.listRunArtifacts(runId);
    setArtifacts(response.artifacts);
    setMessages((current) => attachArtifactsToLastAssistantMessage(current, runId, response.artifacts));
  }

  async function refreshRun() {
    if (!lastRunId) {
      return;
    }
    try {
      await reconcileRun(lastRunId);
    } catch (error) {
      appendLocalError(error);
    }
  }

  async function cancelRun() {
    const runId = activeRunId;
    if (!runId) {
      return;
    }
    cancelingRunIdRef.current = runId;
    try {
      await client.cancelRun(runId);
      abortRef.current?.abort();
      await reconcileRun(runId);
    } catch (error) {
      appendLocalError(error);
    } finally {
      if (cancelingRunIdRef.current === runId) {
        cancelingRunIdRef.current = null;
      }
    }
  }

  async function downloadArtifact(artifact: DemoArtifact) {
    if (!artifact.runId) {
      return;
    }
    try {
      const download = await fetchArtifactDownload({
        apiKey,
        baseUrl,
        artifactId: artifact.id,
        runId: artifact.runId,
      });
      triggerBrowserDownload(download);
    } catch (error) {
      appendLocalError(error);
    }
  }

  function appendLocalError(error: unknown) {
    const formatted = formatError(error);
    setMessages((current) => [
      ...current,
      {
        id: nextLocalId('assistant'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        error: formatted,
        runStatus: 'failed',
      },
    ]);
  }

  return (
    <main className="app-shell">
      <section className="console-layout" aria-label="Daemon test console">
        <header className="top-bar">
          <div>
            <p className="eyebrow">Claude Code Runner</p>
            <h1>Daemon Test Console</h1>
          </div>
          <div className="top-bar-meta">
            <span>{profiles.length} profiles</span>
            <span>{activeRunId ?? 'no active run'}</span>
          </div>
        </header>
        <aside className="setup-panel">
          <ConnectionPanel
            apiKey={apiKey}
            baseUrl={baseUrl}
            healthStatus={healthStatus}
            onApiKeyChange={setApiKey}
            onBaseUrlChange={setBaseUrl}
            onCheckHealth={checkHealth}
            onLoadProfiles={loadProfiles}
            profilesLoaded={profiles.length > 0}
          />
          <WorkspacePanel
            artifactRuleIds={artifactRuleIds}
            eventVisibility={eventVisibility}
            files={selectedFiles}
            model={model}
            onAddFiles={addFiles}
            onArtifactRuleIdsChange={setArtifactRuleIds}
            onEventVisibilityChange={setEventVisibility}
            onFileTargetPathChange={updateFileTargetPath}
            onModelChange={setModel}
            onProfileIdChange={selectProfile}
            onRemoveFile={(fileId) => setSelectedFiles((current) => current.filter((file) => file.id !== fileId))}
            onSkillIdChange={setSkillId}
            onWorkspaceIdentityChange={setWorkspaceIdentity}
            profileId={profileId}
            profiles={profiles}
            skillId={skillId}
            workflowMode={workflowMode}
            workspaceId={workspaceId}
            workspaceIdentity={workspaceIdentity}
          />
        </aside>
        <ChatPanel
          activeRunId={activeRunId}
          artifacts={artifacts}
          messages={messages}
          onCancelRun={cancelRun}
          onClear={() => {
            setMessages([]);
            setArtifacts([]);
          }}
          onDownloadArtifact={downloadArtifact}
          onFilesSelected={addFiles}
          onRefreshRun={refreshRun}
          onSend={handleSend}
          onWorkflowModeChange={setWorkflowMode}
          runStatus={runStatus}
          selectedFiles={selectedFiles}
          workflowMode={workflowMode}
          workspaceKey={workspaceKey}
        />
      </section>
    </main>
  );
}

function nextLocalId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function formatError(error: unknown): { code?: string; message: string } {
  if (error instanceof DaemonApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

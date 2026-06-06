import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RpaApiClient } from '../api/rpa-api-client.js';
import type {
  RpaExecutionArtifactSummary,
  RpaExecutionEvent,
  RpaExecutionMode,
  RpaExecutionStatus,
  RpaFlowDetailResponse,
  StartRpaExecutionRequest,
  StartRpaExecutionResponse,
} from '../shared/rpa-api-types.js';
import { ArtifactPanel } from './ArtifactPanel.js';
import { ExecutionControlBar, type ExecutionControlBarStartInput } from './ExecutionControlBar.js';
import { ExecutionLogPanel } from './ExecutionLogPanel.js';
import { ScreenshotPanel } from './ScreenshotPanel.js';
import { StatusBadge } from './StatusBadge.js';
import { StepList } from './StepList.js';

export interface RuntimeVerificationApiClient {
  getFlow(flowId: string): Promise<RpaFlowDetailResponse>;
  startExecution(input: StartRpaExecutionRequest): Promise<StartRpaExecutionResponse>;
  cancelExecution(executionId: string): Promise<{ ok: true }>;
  getExecutionStatus(executionId: string): Promise<{ status: RpaExecutionStatus; failedStepId?: string }>;
  getExecutionLogs(executionId: string): Promise<{ stdout: string; stderr: string }>;
  getExecutionArtifacts(executionId: string): Promise<{ artifacts: RpaExecutionArtifactSummary[] }>;
  getCurrentScreenshotUrl(executionId: string, cacheKey?: string | number): string;
  subscribeExecutionEvents(
    executionId: string,
    handlers: { onEvent: (event: RpaExecutionEvent) => void; onError?: (error: unknown) => void },
  ): () => void;
}

type RuntimeVerificationParamValue = string | number | boolean | null;

export interface RuntimeVerificationAutoStartRequest {
  requestId: string;
  flowId: string;
  mode: RpaExecutionMode;
  daemonRunId?: string;
  params?: Record<string, RuntimeVerificationParamValue>;
}

export interface RuntimeVerificationWorkspaceProps {
  initialFlowId?: string;
  flowId?: string;
  onFlowIdChange?: (flowId: string) => void;
  autoStartRequest?: RuntimeVerificationAutoStartRequest;
  onRepairRequest?: (input: { executionId: string; failedStepId?: string }) => void;
  client?: RuntimeVerificationApiClient;
}

type ScreenshotState =
  | { status: 'idle'; url?: undefined }
  | { status: 'loading'; url?: undefined }
  | { status: 'ready'; url: string }
  | { status: 'error'; url?: undefined; message: string };

const terminalStatuses = new Set<RpaExecutionStatus>(['succeeded', 'failed', 'canceled', 'timed_out']);

export function RuntimeVerificationWorkspace({
  initialFlowId = 'case_query',
  flowId: controlledFlowId,
  onFlowIdChange,
  autoStartRequest,
  onRepairRequest,
  client: injectedClient,
}: RuntimeVerificationWorkspaceProps) {
  const defaultClient = useMemo(() => new RpaApiClient(), []);
  const client = injectedClient ?? defaultClient;
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const loadRequestIdRef = useRef(0);
  const seenEventSequencesRef = useRef(new Set<number>());
  const lastAutoStartRequestIdRef = useRef<string | null>(null);

  const [uncontrolledFlowId, setUncontrolledFlowId] = useState(initialFlowId);
  const flowId = controlledFlowId ?? uncontrolledFlowId;
  const [mode, setMode] = useState<RpaExecutionMode>('verify');
  const [dryRun, setDryRun] = useState(true);
  const [headless, setHeadless] = useState(false);
  const [paramsText, setParamsText] = useState('{}');

  const [flow, setFlow] = useState<RpaFlowDetailResponse | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [flowLoading, setFlowLoading] = useState(false);

  const [executionId, setExecutionId] = useState<string | undefined>();
  const [executionStatus, setExecutionStatus] = useState<RpaExecutionStatus | 'idle'>('idle');
  const [failedStepId, setFailedStepId] = useState<string | undefined>();
  const [events, setEvents] = useState<RpaExecutionEvent[]>([]);
  const [stdout, setStdout] = useState('');
  const [stderr, setStderr] = useState('');
  const [artifacts, setArtifacts] = useState<RpaExecutionArtifactSummary[]>([]);
  const [screenshot, setScreenshot] = useState<ScreenshotState>({ status: 'idle' });
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const updateFlowId = useCallback(
    (nextFlowId: string) => {
      if (controlledFlowId === undefined) {
        setUncontrolledFlowId(nextFlowId);
      }
      onFlowIdChange?.(nextFlowId);
    },
    [controlledFlowId, onFlowIdChange],
  );

  const handleRuntimeError = useCallback((error: unknown) => {
    setRuntimeError(error instanceof Error ? error.message : 'RPA runtime request failed.');
  }, []);

  const loadFlow = useCallback(
    async (nextFlowId: string): Promise<RpaFlowDetailResponse | null> => {
      const trimmedFlowId = nextFlowId.trim();
      const requestId = ++loadRequestIdRef.current;

      if (!trimmedFlowId) {
        setFlow(null);
        setFlowError('Flow ID is required.');
        return null;
      }

      setFlowLoading(true);
      setFlowError(null);
      try {
        const detail = await client.getFlow(trimmedFlowId);
        if (requestId === loadRequestIdRef.current) {
          setFlow(detail);
        }
        return detail;
      } catch (error) {
        if (requestId === loadRequestIdRef.current) {
          setFlow(null);
          setFlowError(error instanceof Error ? error.message : 'Failed to load flow.');
        }
        return null;
      } finally {
        if (requestId === loadRequestIdRef.current) {
          setFlowLoading(false);
        }
      }
    },
    [client],
  );

  useEffect(() => {
    const trimmedFlowId = flowId.trim();
    if (!trimmedFlowId) {
      setFlow(null);
      setFlowError('Flow ID is required.');
      return;
    }

    void loadFlow(trimmedFlowId);
  }, [flowId, loadFlow]);

  useEffect(() => {
    return () => unsubscribeRef.current?.();
  }, []);

  const refreshLogs = useCallback(async (nextExecutionId: string) => {
    const logResponse = await client.getExecutionLogs(nextExecutionId);
    setStdout(logResponse.stdout);
    setStderr(logResponse.stderr);
  }, [client]);

  const refreshArtifacts = useCallback(async (nextExecutionId: string) => {
    const artifactResponse = await client.getExecutionArtifacts(nextExecutionId);
    setArtifacts(artifactResponse.artifacts);
  }, [client]);

  const refreshStatus = useCallback(async (nextExecutionId: string) => {
    const statusResponse = await client.getExecutionStatus(nextExecutionId);
    setExecutionStatus(statusResponse.status);
    setFailedStepId(statusResponse.failedStepId);
  }, [client]);

  const refreshScreenshot = useCallback((nextExecutionId: string, cacheKey: string | number) => {
    setScreenshot({
      status: 'ready',
      url: client.getCurrentScreenshotUrl(nextExecutionId, cacheKey),
    });
  }, [client]);

  const handleExecutionEvent = useCallback((event: RpaExecutionEvent) => {
    if (event.sequence !== undefined) {
      if (seenEventSequencesRef.current.has(event.sequence)) return;
      seenEventSequencesRef.current.add(event.sequence);
    }

    setEvents((current) => [...current, event]);

    if (event.type === 'run.started') {
      setExecutionStatus('running');
    }
    if (event.type === 'step.failed') {
      setFailedStepId(event.stepId);
    }
    if (event.type === 'log') {
      void refreshLogs(event.executionId).catch(handleRuntimeError);
    }
    if (event.type === 'step.screenshot') {
      refreshScreenshot(event.executionId, event.sequence ?? event.timestamp);
    }
    if (event.type === 'artifact.created') {
      void refreshArtifacts(event.executionId).catch(handleRuntimeError);
      if (event.role === 'screenshot') {
        refreshScreenshot(event.executionId, event.sequence ?? event.timestamp);
      }
    }
    if (event.type === 'run.completed') {
      if (event.status) setExecutionStatus(event.status);
      refreshScreenshot(event.executionId, event.sequence ?? event.timestamp);
      void Promise.all([
        refreshStatus(event.executionId),
        refreshLogs(event.executionId),
        refreshArtifacts(event.executionId),
      ]).catch(handleRuntimeError);
    }
  }, [handleRuntimeError, refreshArtifacts, refreshLogs, refreshScreenshot, refreshStatus]);

  const startExecutionRequest = useCallback(async (input: StartRpaExecutionRequest) => {
    setBusy(true);
    setRuntimeError(null);
    setEvents([]);
    setStdout('');
    setStderr('');
    setArtifacts([]);
    setFailedStepId(undefined);
    setScreenshot({ status: 'idle' });
    seenEventSequencesRef.current.clear();
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;

    try {
      if (flow?.flowId !== input.flowId) {
        const loadedFlow = await loadFlow(input.flowId);
        if (!loadedFlow) return;
      }
      const started = await client.startExecution(input);
      setExecutionId(started.executionId);
      setExecutionStatus(started.status);
      unsubscribeRef.current = client.subscribeExecutionEvents(started.executionId, {
        onEvent: handleExecutionEvent,
        onError: handleRuntimeError,
      });
    } catch (error) {
      handleRuntimeError(error);
    } finally {
      setBusy(false);
    }
  }, [client, flow?.flowId, handleExecutionEvent, handleRuntimeError, loadFlow]);

  const startExecution = useCallback(
    async (input: ExecutionControlBarStartInput) => {
      await startExecutionRequest(input);
    },
    [startExecutionRequest],
  );

  useEffect(() => {
    if (!autoStartRequest || lastAutoStartRequestIdRef.current === autoStartRequest.requestId) return;
    lastAutoStartRequestIdRef.current = autoStartRequest.requestId;

    const dryRunDefault = autoStartRequest.mode === 'verify';
    const headlessDefault = autoStartRequest.mode === 'run';
    updateFlowId(autoStartRequest.flowId);
    setMode(autoStartRequest.mode);
    setDryRun(dryRunDefault);
    setHeadless(headlessDefault);
    setParamsText(JSON.stringify(autoStartRequest.params ?? {}, null, 2));

    void startExecutionRequest({
      flowId: autoStartRequest.flowId,
      daemonRunId: autoStartRequest.daemonRunId,
      mode: autoStartRequest.mode,
      dryRun: dryRunDefault,
      headless: headlessDefault,
      params: autoStartRequest.params ?? {},
    });
  }, [autoStartRequest, startExecutionRequest, updateFlowId]);

  const cancelExecution = async () => {
    if (!executionId) return;
    setBusy(true);
    setRuntimeError(null);
    try {
      await client.cancelExecution(executionId);
      setExecutionStatus('canceling');
    } catch (error) {
      handleRuntimeError(error);
    } finally {
      setBusy(false);
    }
  };

  const steps = flow?.dsl.steps ?? [];
  const statusTone = executionStatus === 'idle' ? 'neutral' : terminalStatuses.has(executionStatus) ? 'ready' : 'warning';

  return (
    <div className="runtime-workspace">
      <div className="runtime-workspace__summary">
        <div>
          <h3>{flow?.title ?? 'No flow loaded'}</h3>
          <p>
            {flowLoading ? 'Loading flow...' : flow ? `${flow.flowId} · ${flow.source}` : 'Enter a flow id to load DSL steps.'}
          </p>
        </div>
        <StatusBadge tone={statusTone}>{executionStatus}</StatusBadge>
      </div>

      <ExecutionControlBar
        activeExecutionId={executionId}
        busy={busy}
        dryRun={dryRun}
        flowId={flowId}
        headless={headless}
        mode={mode}
        paramsText={paramsText}
        onCancel={cancelExecution}
        onDryRunChange={setDryRun}
        onFlowIdChange={updateFlowId}
        onHeadlessChange={setHeadless}
        onModeChange={setMode}
        onParamsTextChange={setParamsText}
        onStart={startExecution}
      />

      {flowError ? <p className="runtime-workspace__error">{flowError}</p> : null}
      {runtimeError ? <p className="runtime-workspace__error">{runtimeError}</p> : null}
      {onRepairRequest && executionId && executionStatus === 'failed' ? (
        <div className="runtime-workspace__actions">
          <button
            type="button"
            className="command-button"
            onClick={() => onRepairRequest({ executionId, failedStepId })}
          >
            Repair with Claude Code
          </button>
        </div>
      ) : null}

      <div className="runtime-workspace__grid">
        <StepList steps={steps} events={events} failedStepId={failedStepId} />
        <ScreenshotPanel
          imageUrl={screenshot.status === 'ready' ? screenshot.url : undefined}
          status={screenshot.status}
          errorMessage={screenshot.status === 'error' ? screenshot.message : undefined}
        />
        <div className="runtime-workspace__side">
          <ExecutionLogPanel events={events} stdout={stdout} stderr={stderr} />
          <ArtifactPanel executionId={executionId} artifacts={artifacts} />
        </div>
      </div>
    </div>
  );
}

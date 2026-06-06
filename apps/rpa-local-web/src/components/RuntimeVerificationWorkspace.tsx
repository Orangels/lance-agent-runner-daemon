import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RpaApiClient } from '../api/rpa-api-client.js';
import type {
  RpaExecutionArtifactSummary,
  RpaExecutionEvent,
  RpaExecutionMode,
  RpaExecutionStatus,
  RpaFlowDetailResponse,
  RpaFlowSummary,
  StartRpaExecutionRequest,
  StartRpaExecutionResponse,
} from '../shared/rpa-api-types.js';
import { normalizeRuntimeParams, type RuntimeParamValue } from '../shared/runtime-params.js';
import { ArtifactPanel } from './ArtifactPanel.js';
import { ExecutionControlBar, type ExecutionControlBarStartInput } from './ExecutionControlBar.js';
import { ExecutionLogPanel } from './ExecutionLogPanel.js';
import { RuntimeParamsForm } from './RuntimeParamsForm.js';
import { ScreenshotPanel } from './ScreenshotPanel.js';
import { StatusBadge } from './StatusBadge.js';
import { StepList } from './StepList.js';

export interface RuntimeVerificationApiClient {
  listFlows(): Promise<{ flows: RpaFlowSummary[] }>;
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

export interface RuntimeVerificationAutoStartRequest {
  requestId: string;
  flowId: string;
  mode: RpaExecutionMode;
  daemonRunId?: string;
  params?: Record<string, RuntimeParamValue>;
}

export interface RuntimeVerificationWorkspaceProps {
  initialFlowId?: string;
  flowId?: string;
  onFlowIdChange?: (flowId: string) => void;
  autoStartRequest?: RuntimeVerificationAutoStartRequest;
  onVerifySucceeded?: (input: { flowId: string; executionId: string }) => void;
  onRepairRequest?: (input: { executionId: string; failedStepId?: string }) => void;
  client?: RuntimeVerificationApiClient;
}

type ScreenshotState =
  | { status: 'idle'; url?: undefined }
  | { status: 'loading'; url?: undefined }
  | { status: 'ready'; url: string }
  | { status: 'error'; url?: undefined; message: string };

const terminalStatuses = new Set<RpaExecutionStatus>(['succeeded', 'failed', 'canceled', 'timed_out']);

interface CurrentExecutionContext {
  executionId: string;
  flowId: string;
  mode: RpaExecutionMode;
}

export function RuntimeVerificationWorkspace({
  initialFlowId = '',
  flowId: controlledFlowId,
  onFlowIdChange,
  autoStartRequest,
  onVerifySucceeded,
  onRepairRequest,
  client: injectedClient,
}: RuntimeVerificationWorkspaceProps) {
  const defaultClient = useMemo(() => new RpaApiClient(), []);
  const client = injectedClient ?? defaultClient;
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const loadRequestIdRef = useRef(0);
  const seenEventSequencesRef = useRef(new Set<number>());
  const lastAutoStartRequestIdRef = useRef<string | null>(null);
  const currentExecutionRef = useRef<CurrentExecutionContext | null>(null);

  const [uncontrolledFlowId, setUncontrolledFlowId] = useState(initialFlowId);
  const flowId = controlledFlowId ?? uncontrolledFlowId;
  const [mode, setMode] = useState<RpaExecutionMode>('verify');
  const [dryRun, setDryRun] = useState(true);
  const [headless, setHeadless] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, RuntimeParamValue>>({});
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});

  const [flow, setFlow] = useState<RpaFlowDetailResponse | null>(null);
  const [flowOptions, setFlowOptions] = useState<RpaFlowSummary[]>([]);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [flowListError, setFlowListError] = useState<string | null>(null);
  const [flowsLoading, setFlowsLoading] = useState(false);
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

  const loadFlowOptions = useCallback(async () => {
    setFlowsLoading(true);
    setFlowListError(null);
    try {
      const response = await client.listFlows();
      setFlowOptions(response.flows);
      if (controlledFlowId === undefined && flowId.trim().length === 0 && response.flows.length > 0) {
        setUncontrolledFlowId(response.flows[0]!.flowId);
      }
    } catch (error) {
      setFlowOptions([]);
      setFlowListError(error instanceof Error ? error.message : 'Failed to load flows.');
    } finally {
      setFlowsLoading(false);
    }
  }, [client, controlledFlowId, flowId]);

  useEffect(() => {
    void loadFlowOptions();
  }, [loadFlowOptions]);

  useEffect(() => {
    const trimmedFlowId = flowId.trim();
    if (!trimmedFlowId) {
      setFlow(null);
      setFlowError(flowOptions.length === 0 ? null : 'Flow selection is required.');
      return;
    }

    void loadFlow(trimmedFlowId);
  }, [flowId, loadFlow]);

  useEffect(() => {
    return () => unsubscribeRef.current?.();
  }, []);

  useEffect(() => {
    if (!flow) {
      setParamValues({});
      setParamErrors({});
      return;
    }

    const defaultValues: Record<string, RuntimeParamValue> = {};
    for (const field of flow.runtimeParams.fields) {
      if (field.defaultValue !== undefined) {
        defaultValues[field.id] = field.defaultValue;
      }
    }
    setParamValues(defaultValues);
    setParamErrors({});
  }, [flow?.flowId]);

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
      const currentExecution = currentExecutionRef.current;
      if (
        event.status === 'succeeded' &&
        currentExecution?.executionId === event.executionId &&
        currentExecution.mode === 'verify'
      ) {
        onVerifySucceeded?.({ flowId: currentExecution.flowId, executionId: event.executionId });
      }
      void Promise.all([
        refreshStatus(event.executionId),
        refreshLogs(event.executionId),
        refreshArtifacts(event.executionId),
      ]).catch(handleRuntimeError);
    }
  }, [handleRuntimeError, onVerifySucceeded, refreshArtifacts, refreshLogs, refreshScreenshot, refreshStatus]);

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
    currentExecutionRef.current = null;

    try {
      const targetFlow = flow?.flowId === input.flowId ? flow : await loadFlow(input.flowId);
      if (!targetFlow) return;

      const normalizedParams = normalizeRuntimeParams(targetFlow.dsl.params, input.params ?? {});
      if (!normalizedParams.ok) {
        setParamErrors(Object.fromEntries(normalizedParams.errors.map((error) => [error.paramId, error.message])));
        if (normalizedParams.errors.some((error) => error.code === 'PARAM_REQUIRED')) {
          setRuntimeError('Runtime params are required before execution can start.');
        }
        return;
      }

      setParamErrors({});
      const started = await client.startExecution({
        ...input,
        params: normalizedParams.value,
      });
      currentExecutionRef.current = {
        executionId: started.executionId,
        flowId: input.flowId,
        mode: input.mode,
      };
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
  }, [client, flow, handleExecutionEvent, handleRuntimeError, loadFlow]);

  const startExecution = useCallback(
    async (input: ExecutionControlBarStartInput) => {
      await startExecutionRequest({
        ...input,
        params: paramValues,
      });
    },
    [paramValues, startExecutionRequest],
  );

  const updateRuntimeParam = useCallback((paramId: string, value: RuntimeParamValue) => {
    setParamValues((current) => ({ ...current, [paramId]: value }));
    setParamErrors((current) => {
      if (!current[paramId]) return current;
      const { [paramId]: _removed, ...nextErrors } = current;
      return nextErrors;
    });
  }, []);

  useEffect(() => {
    if (!autoStartRequest || lastAutoStartRequestIdRef.current === autoStartRequest.requestId) return;
    lastAutoStartRequestIdRef.current = autoStartRequest.requestId;

    const dryRunDefault = autoStartRequest.mode === 'verify';
    const headlessDefault = autoStartRequest.mode === 'run';
    updateFlowId(autoStartRequest.flowId);
    setMode(autoStartRequest.mode);
    setDryRun(dryRunDefault);
    setHeadless(headlessDefault);
    setParamValues(autoStartRequest.params ?? {});
    setParamErrors({});

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
        flowOptions={flowOptions}
        flowsLoading={flowsLoading}
        headless={headless}
        mode={mode}
        onCancel={cancelExecution}
        onDryRunChange={setDryRun}
        onFlowIdChange={updateFlowId}
        onHeadlessChange={setHeadless}
        onModeChange={setMode}
        onStart={startExecution}
      />

      <RuntimeParamsForm
        errors={paramErrors}
        fields={flow?.runtimeParams.fields ?? []}
        values={paramValues}
        onChange={updateRuntimeParam}
      />

      {flowError ? <p className="runtime-workspace__error">{flowError}</p> : null}
      {flowListError ? <p className="runtime-workspace__error">{flowListError}</p> : null}
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

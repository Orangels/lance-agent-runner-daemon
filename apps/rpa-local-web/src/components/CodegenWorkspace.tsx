import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RpaApiClient } from '../api/rpa-api-client.js';
import type {
  CodegenSessionStatus,
  CodegenSessionStatusResponse,
  StartCodegenHardeningRequest,
  StartCodegenSessionRequest,
  SubmitCodegenQuestionAnswersRequest,
} from '../shared/codegen-types.js';
import { RuntimeVerificationWorkspace, type RuntimeVerificationApiClient } from './RuntimeVerificationWorkspace.js';
import { StatusBadge } from './StatusBadge.js';
import { DaemonHardeningPanel } from './DaemonHardeningPanel.js';
import { QuestionForm } from './QuestionForm.js';

export interface CodegenApiClient {
  startCodegenSession(request: StartCodegenSessionRequest): Promise<{ sessionId: string; flowId: string; status: CodegenSessionStatus; targetUrl: string }>;
  getCodegenSession(sessionId: string): Promise<CodegenSessionStatusResponse>;
  cancelCodegenSession(sessionId: string): Promise<{ sessionId: string; status: CodegenSessionStatus }>;
  startCodegenHardening(
    sessionId: string,
    request: StartCodegenHardeningRequest,
  ): Promise<{ sessionId: string; status: CodegenSessionStatus; daemonRunId?: string }>;
  submitCodegenQuestionAnswers(
    sessionId: string,
    request: SubmitCodegenQuestionAnswersRequest,
  ): Promise<{ sessionId: string; status: CodegenSessionStatus; daemonRunId?: string }>;
}

export interface CodegenWorkspaceProps {
  client?: CodegenApiClient;
  runtimeClient?: RuntimeVerificationApiClient;
}

const terminalStatuses = new Set<CodegenSessionStatus>(['hardened', 'failed', 'cancelled']);

export function CodegenWorkspace({ client: injectedClient, runtimeClient }: CodegenWorkspaceProps) {
  const defaultClient = useMemo(() => new RpaApiClient(), []);
  const client = injectedClient ?? defaultClient;
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [targetUrl, setTargetUrl] = useState('https://example.com');
  const [flowId, setFlowId] = useState('case_query');
  const [flowName, setFlowName] = useState('');
  const [session, setSession] = useState<CodegenSessionStatusResponse | null>(null);
  const [hardeningRequirement, setHardeningRequirement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyRequestId, setVerifyRequestId] = useState<string | null>(null);

  const refreshSession = useCallback(
    async (sessionId: string) => {
      const next = await client.getCodegenSession(sessionId);
      setSession(next);
      if (next.requirement && !hardeningRequirement) {
        setHardeningRequirement(next.requirement);
      }
      return next;
    },
    [client, hardeningRequirement],
  );

  useEffect(() => {
    if (!session || terminalStatuses.has(session.status)) {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      return;
    }
    if (pollTimerRef.current) return;
    pollTimerRef.current = setInterval(() => {
      void refreshSession(session.sessionId).catch((pollError) => {
        setError(pollError instanceof Error ? pollError.message : 'Codegen status refresh failed.');
      });
    }, 1_000);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [refreshSession, session]);

  const start = async () => {
    setBusy(true);
    setError(null);
    setVerifyRequestId(null);
    setHardeningRequirement('');
    try {
      const started = await client.startCodegenSession({ targetUrl, flowId, flowName });
      setSession({
        sessionId: started.sessionId,
        flowId: started.flowId,
        targetUrl: started.targetUrl,
        status: started.status,
        logs: [],
        questionForm: null,
        artifacts: [],
        error: null,
      });
      await refreshSession(started.sessionId);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Codegen session failed to start.');
    } finally {
      setBusy(false);
    }
  };

  const startHardening = async () => {
    if (!session) return;
    const requirement = hardeningRequirement.trim();
    if (!requirement) {
      setError('任务需求 / 最终产物不能为空。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.startCodegenHardening(session.sessionId, { requirement });
      await refreshSession(session.sessionId);
    } catch (hardeningError) {
      setError(hardeningError instanceof Error ? hardeningError.message : 'Codegen hardening failed to start.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await client.cancelCodegenSession(session.sessionId);
      await refreshSession(session.sessionId);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Codegen session cancel failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitAnswers = async (request: SubmitCodegenQuestionAnswersRequest) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await client.submitCodegenQuestionAnswers(session.sessionId, request);
      await refreshSession(session.sessionId);
    } catch (answerError) {
      setError(answerError instanceof Error ? answerError.message : 'Question-form submission failed.');
    } finally {
      setBusy(false);
    }
  };

  const statusTone = !session ? 'neutral' : session.status === 'hardened' ? 'ready' : 'warning';
  const autoStartRequest =
    verifyRequestId && session
      ? {
          requestId: verifyRequestId,
          flowId: session.flowId,
          daemonRunId: session.daemonRunId,
          mode: 'verify' as const,
          params: {},
        }
      : undefined;

  return (
    <div className="codegen-workspace">
      <form
        className="codegen-control"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label className="field">
          <span>Target URL</span>
          <input value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} />
        </label>
        <label className="field">
          <span>Flow ID</span>
          <input value={flowId} onChange={(event) => setFlowId(event.target.value)} />
        </label>
        <label className="field">
          <span>Flow name</span>
          <input value={flowName} onChange={(event) => setFlowName(event.target.value)} />
        </label>
        <button type="submit" className="command-button" disabled={busy}>
          Start recording
        </button>
        <button type="button" className="command-button command-button--secondary" disabled={!session || busy} onClick={cancel}>
          Cancel
        </button>
      </form>

      {error ? <p className="runtime-workspace__error">{error}</p> : null}
      {session?.error ? <p className="runtime-workspace__error">{session.error.message}</p> : null}

      <div className="codegen-summary">
        <div>
          <h3>{session?.flowId ?? flowId}</h3>
          <p>{session?.targetUrl ?? targetUrl}</p>
        </div>
        <StatusBadge tone={statusTone}>{session?.status ?? 'idle'}</StatusBadge>
      </div>

      <DaemonHardeningPanel daemonRunId={session?.daemonRunId} logs={session?.logs ?? []} artifacts={session?.artifacts ?? []} />

      {session?.status === 'completed' ? (
        <form
          className="daemon-hardening-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void startHardening();
          }}
        >
          <label className="field">
            <span>任务需求 / 最终产物</span>
            <textarea
              value={hardeningRequirement}
              onChange={(event) => setHardeningRequirement(event.target.value)}
              placeholder="描述这次录制要完成的业务目标、需要泛化的参数，以及最终要输出的文件或数据。"
              rows={4}
            />
          </label>
          <button type="submit" className="command-button" disabled={busy || hardeningRequirement.trim().length === 0}>
            生成脚本
          </button>
        </form>
      ) : null}

      {session?.questionForm ? (
        <QuestionForm
          busy={busy}
          form={session.questionForm}
          onSubmit={(answers) => submitAnswers({ formId: session.questionForm!.formId, answers })}
        />
      ) : null}

      {session?.status === 'hardened' ? (
        <div className="codegen-actions">
          <button
            type="button"
            className="command-button"
            onClick={() => setVerifyRequestId(`${session.sessionId}-${Date.now()}`)}
          >
            Verify flow
          </button>
        </div>
      ) : null}

      {autoStartRequest ? (
        <RuntimeVerificationWorkspace
          flowId={session?.flowId}
          onFlowIdChange={() => undefined}
          autoStartRequest={autoStartRequest}
          client={runtimeClient}
        />
      ) : null}
    </div>
  );
}

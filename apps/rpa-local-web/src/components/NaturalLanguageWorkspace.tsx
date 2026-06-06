import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RpaApiClient } from '../api/rpa-api-client.js';
import type {
  NaturalLanguageSessionStatus,
  NaturalLanguageSessionStatusResponse,
  RepairNaturalLanguageSessionRequest,
  StartNaturalLanguageSessionRequest,
  SubmitNaturalLanguageQuestionAnswersRequest,
} from '../shared/natural-language-types.js';
import { DaemonHardeningPanel } from './DaemonHardeningPanel.js';
import { QuestionForm } from './QuestionForm.js';
import { RuntimeVerificationWorkspace, type RuntimeVerificationApiClient } from './RuntimeVerificationWorkspace.js';
import { StatusBadge } from './StatusBadge.js';

export interface NaturalLanguageApiClient {
  startNaturalLanguageSession(
    request: StartNaturalLanguageSessionRequest,
  ): Promise<{ sessionId: string; flowId: string; status: NaturalLanguageSessionStatus; targetUrl: string }>;
  getNaturalLanguageSession(sessionId: string): Promise<NaturalLanguageSessionStatusResponse>;
  cancelNaturalLanguageSession(sessionId: string): Promise<NaturalLanguageSessionStatusResponse>;
  submitNaturalLanguageQuestionAnswers(
    sessionId: string,
    request: SubmitNaturalLanguageQuestionAnswersRequest,
  ): Promise<{ sessionId: string; status: NaturalLanguageSessionStatus; daemonRunId?: string }>;
  repairNaturalLanguageSession(
    sessionId: string,
    request: RepairNaturalLanguageSessionRequest,
  ): Promise<NaturalLanguageSessionStatusResponse>;
}

export interface NaturalLanguageWorkspaceProps {
  client?: NaturalLanguageApiClient;
  runtimeClient?: RuntimeVerificationApiClient;
}

const terminalStatuses = new Set<NaturalLanguageSessionStatus>(['generated', 'failed', 'cancelled']);

export function NaturalLanguageWorkspace({ client: injectedClient, runtimeClient }: NaturalLanguageWorkspaceProps) {
  const defaultClient = useMemo(() => new RpaApiClient(), []);
  const client = injectedClient ?? defaultClient;
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [targetUrl, setTargetUrl] = useState('https://example.com');
  const [flowId, setFlowId] = useState('case_query');
  const [flowName, setFlowName] = useState('');
  const [requirement, setRequirement] = useState('Search cases by case number.');
  const [businessConstraints, setBusinessConstraints] = useState('');
  const [safetyNotes, setSafetyNotes] = useState('');
  const [session, setSession] = useState<NaturalLanguageSessionStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showVerification, setShowVerification] = useState(false);

  const refreshSession = useCallback(
    async (sessionId: string) => {
      const next = await client.getNaturalLanguageSession(sessionId);
      setSession(next);
      return next;
    },
    [client],
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
        setError(pollError instanceof Error ? pollError.message : 'Natural-language status refresh failed.');
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
    setShowVerification(false);
    try {
      const started = await client.startNaturalLanguageSession({
        targetUrl,
        flowId,
        flowName,
        requirement,
        businessConstraints,
        safetyNotes,
      });
      setSession({
        sessionId: started.sessionId,
        flowId: started.flowId,
        targetUrl: started.targetUrl,
        requirement,
        status: started.status,
        logs: [],
        questionForm: null,
        artifacts: [],
        error: null,
      });
      await refreshSession(started.sessionId);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Natural-language generation failed to start.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await client.cancelNaturalLanguageSession(session.sessionId);
      await refreshSession(session.sessionId);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Natural-language generation cancel failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitAnswers = async (request: SubmitNaturalLanguageQuestionAnswersRequest) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    setShowVerification(false);
    try {
      await client.submitNaturalLanguageQuestionAnswers(session.sessionId, request);
      await refreshSession(session.sessionId);
    } catch (answerError) {
      setError(answerError instanceof Error ? answerError.message : 'Question-form submission failed.');
    } finally {
      setBusy(false);
    }
  };

  const repair = async (request: RepairNaturalLanguageSessionRequest) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await client.repairNaturalLanguageSession(session.sessionId, request);
      await refreshSession(session.sessionId);
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : 'Natural-language repair failed.');
    } finally {
      setBusy(false);
    }
  };

  const statusTone = !session ? 'neutral' : session.status === 'generated' ? 'ready' : 'warning';

  return (
    <div className="natural-language-workspace">
      <form
        className="natural-language-control"
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
        <label className="field field--wide">
          <span>Requirement</span>
          <textarea value={requirement} rows={4} onChange={(event) => setRequirement(event.target.value)} />
        </label>
        <label className="field field--wide">
          <span>Business constraints</span>
          <textarea
            value={businessConstraints}
            rows={3}
            onChange={(event) => setBusinessConstraints(event.target.value)}
          />
        </label>
        <label className="field field--wide">
          <span>Safety notes</span>
          <textarea value={safetyNotes} rows={3} onChange={(event) => setSafetyNotes(event.target.value)} />
        </label>
        <div className="natural-language-control__actions">
          <button type="submit" className="command-button" disabled={busy}>
            Generate flow
          </button>
          <button type="button" className="command-button command-button--secondary" disabled={!session || busy} onClick={cancel}>
            Cancel
          </button>
        </div>
      </form>

      {error ? <p className="runtime-workspace__error">{error}</p> : null}
      {session?.error ? <p className="runtime-workspace__error">{session.error.message}</p> : null}

      <div className="codegen-summary">
        <div>
          <h3>{session?.flowName || session?.flowId || flowId}</h3>
          <p>{session?.targetUrl ?? targetUrl}</p>
        </div>
        <StatusBadge tone={statusTone}>{session?.status ?? 'idle'}</StatusBadge>
      </div>

      <DaemonHardeningPanel daemonRunId={session?.daemonRunId} logs={session?.logs ?? []} artifacts={session?.artifacts ?? []} />

      {session?.questionForm ? (
        <QuestionForm
          busy={busy}
          form={session.questionForm}
          onSubmit={(answers) => submitAnswers({ formId: session.questionForm!.formId, answers })}
        />
      ) : null}

      {session?.status === 'generated' ? (
        <div className="codegen-actions">
          <button type="button" className="command-button" onClick={() => setShowVerification(true)}>
            Verify flow
          </button>
        </div>
      ) : null}

      {showVerification && session?.status === 'generated' ? (
        <RuntimeVerificationWorkspace
          flowId={session.flowId}
          onFlowIdChange={() => undefined}
          client={runtimeClient}
          onRepairRequest={({ executionId }) => repair({ executionId })}
        />
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { RpaApiClient } from '../api/rpa-api-client.js';
import type {
  DeleteRpaFlowResponse,
  ImportRpaPackageResponse,
  RpaFlowDetailResponse,
  RpaFlowListResponse,
  RpaFlowSummary,
} from '../shared/rpa-api-types.js';
import { RuntimeVerificationWorkspace, type RuntimeVerificationApiClient } from './RuntimeVerificationWorkspace.js';
import { StatusBadge } from './StatusBadge.js';

export interface FlowAssetsApiClient {
  listFlows(): Promise<RpaFlowListResponse>;
  getFlow(flowId: string): Promise<RpaFlowDetailResponse>;
  deleteFlow(flowId: string): Promise<DeleteRpaFlowResponse>;
  getPackageDownloadUrl(flowId: string): string;
  importPackage(file: File): Promise<ImportRpaPackageResponse>;
}

export interface FlowAssetsWorkspaceProps {
  client?: FlowAssetsApiClient;
  runtimeClient?: RuntimeVerificationApiClient;
}

export function FlowAssetsWorkspace({ client: injectedClient, runtimeClient }: FlowAssetsWorkspaceProps) {
  const defaultClient = useMemo(() => new RpaApiClient(), []);
  const client = injectedClient ?? defaultClient;
  const [flows, setFlows] = useState<RpaFlowSummary[]>([]);
  const [flow, setFlow] = useState<RpaFlowDetailResponse | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verificationMode, setVerificationMode] = useState<'verify' | 'run' | null>(null);
  const [autoStartNonce, setAutoStartNonce] = useState(0);

  const refreshFlows = useCallback(async () => {
    const response = await client.listFlows();
    setFlows(response.flows);
  }, [client]);

  useEffect(() => {
    let active = true;
    void client
      .listFlows()
      .then((response) => {
        if (active) setFlows(response.flows);
      })
      .catch((listError) => {
        if (!active) return;
        setError(listError instanceof Error ? listError.message : 'Failed to list flows.');
      });
    return () => {
      active = false;
    };
  }, [client]);

  const loadFlow = async (nextFlowId: string) => {
    const trimmedFlowId = nextFlowId.trim();
    if (!trimmedFlowId) {
      setError('Flow ID is required.');
      setFlow(null);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const detail = await client.getFlow(trimmedFlowId);
      setFlow(detail);
      setVerificationMode(null);
    } catch (loadError) {
      setFlow(null);
      setError(loadError instanceof Error ? loadError.message : 'Failed to load flow.');
    } finally {
      setBusy(false);
    }
  };

  const importPackage = async () => {
    if (!selectedFile) {
      setError('Choose a .rpa.zip package first.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const imported = await client.importPackage(selectedFile);
      setMessage(`Imported ${imported.flowId}. Verify is required before run.`);
      await refreshFlows();
      await loadFlow(imported.flowId);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Package import failed.');
    } finally {
      setBusy(false);
    }
  };

  const deleteFlow = async (summary: RpaFlowSummary) => {
    const confirmed = window.confirm(
      `Delete flow "${summary.title}" (${summary.flowId})? This removes local flow artifacts but keeps execution history.`,
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await client.deleteFlow(summary.flowId);
      if (flow?.flowId === summary.flowId) {
        setFlow(null);
        setVerificationMode(null);
      }
      setMessage(`Deleted ${summary.flowId}.`);
      await refreshFlows();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Flow delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const canRun = flow !== null && flow.provenance.requiresVerifyBeforeRun === false;

  const startFlowExecution = (nextMode: 'verify' | 'run') => {
    setAutoStartNonce((current) => current + 1);
    setVerificationMode(nextMode);
  };

  return (
    <div className="flow-assets-workspace">
      <form className="flow-assets-toolbar">
        <label className="field">
          <span>Import .rpa.zip</span>
          <input
            aria-label="Import .rpa.zip"
            type="file"
            accept=".rpa.zip,application/zip"
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button type="button" className="command-button command-button--secondary" disabled={busy} onClick={importPackage}>
          <Upload aria-hidden="true" />
          <span>Import package</span>
        </button>
      </form>

      {error ? <p className="runtime-workspace__error">{error}</p> : null}
      {message ? <p className="flow-assets-workspace__message">{message}</p> : null}

      <section className="flow-assets-list" aria-label="Generated flows">
        {flows.length > 0 ? (
          <table className="flow-assets-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Flow ID</th>
                <th>Source</th>
                <th>Verify state</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {flows.map((summary) => (
                <tr key={summary.flowId}>
                  <td>{summary.title}</td>
                  <td>
                    <code>{summary.flowId}</code>
                  </td>
                  <td>{summary.source}</td>
                  <td>
                    <StatusBadge tone={summary.requiresVerifyBeforeRun ? 'warning' : 'ready'}>
                      {summary.requiresVerifyBeforeRun ? 'Verify required' : 'Ready'}
                    </StatusBadge>
                  </td>
                  <td>
                    <div className="flow-assets-table__actions">
                      <button
                        type="button"
                        className="command-button command-button--secondary"
                        aria-label={`Load ${summary.flowId}`}
                        disabled={busy}
                        onClick={() => {
                          void loadFlow(summary.flowId);
                        }}
                      >
                        Load
                      </button>
                      <a
                        className="command-button command-button--secondary"
                        aria-label={`Export ${summary.flowId}`}
                        href={client.getPackageDownloadUrl(summary.flowId)}
                      >
                        <Download aria-hidden="true" />
                        <span>Export</span>
                      </a>
                      <button
                        type="button"
                        className="command-button command-button--secondary"
                        aria-label={`Delete ${summary.flowId}`}
                        disabled={busy}
                        onClick={() => {
                          void deleteFlow(summary);
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                        <span>Delete</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="flow-assets-empty">No flows available. Generate or import a flow first.</p>
        )}
      </section>

      {flow ? (
        <section className="flow-assets-summary">
          <div>
            <h3>{flow.title}</h3>
            <p>
              {flow.flowId} · {flow.runtimeParams.fields.length} params · {flow.dsl.steps.length} steps
            </p>
          </div>
          <StatusBadge tone={flow.provenance.requiresVerifyBeforeRun ? 'warning' : 'ready'}>
            {flow.provenance.source}
          </StatusBadge>
          <dl>
            <div>
              <dt>Verify state</dt>
              <dd>{flow.provenance.requiresVerifyBeforeRun ? 'Verify required before run' : 'Ready to run'}</dd>
            </div>
            <div>
              <dt>Original flow</dt>
              <dd>{flow.provenance.originalFlowId ?? flow.flowId}</dd>
            </div>
            <div>
              <dt>Package hash</dt>
              <dd>{flow.provenance.packageSha256 ?? 'local'}</dd>
            </div>
          </dl>
          <div className="flow-assets-actions">
            <a className="command-button command-button--secondary" href={client.getPackageDownloadUrl(flow.flowId)}>
              <Download aria-hidden="true" />
              <span>Export .rpa.zip</span>
            </a>
            <button type="button" className="command-button" onClick={() => startFlowExecution('verify')}>
              Verify flow
            </button>
            <button type="button" className="command-button" disabled={!canRun} onClick={() => startFlowExecution('run')}>
              Run flow
            </button>
          </div>
        </section>
      ) : null}

      {flow && verificationMode ? (
        <RuntimeVerificationWorkspace
          flowId={flow.flowId}
          onFlowIdChange={() => undefined}
          autoStartRequest={{
            requestId: `${flow.flowId}-${verificationMode}-${autoStartNonce}`,
            flowId: flow.flowId,
            mode: verificationMode,
          }}
          onVerifySucceeded={() => {
            setVerificationMode(null);
            void Promise.all([loadFlow(flow.flowId), refreshFlows()]);
          }}
          client={runtimeClient}
        />
      ) : null}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { RpaApiClient } from '../api/rpa-api-client.js';
import type { ImportRpaPackageResponse, RpaFlowDetailResponse } from '../shared/rpa-api-types.js';
import { RuntimeVerificationWorkspace, type RuntimeVerificationApiClient } from './RuntimeVerificationWorkspace.js';
import { StatusBadge } from './StatusBadge.js';

export interface FlowAssetsApiClient {
  getFlow(flowId: string): Promise<RpaFlowDetailResponse>;
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
  const [flowIdInput, setFlowIdInput] = useState('case_query');
  const [flow, setFlow] = useState<RpaFlowDetailResponse | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verificationMode, setVerificationMode] = useState<'verify' | 'run' | null>(null);
  const [autoStartNonce, setAutoStartNonce] = useState(0);

  const loadFlow = async (nextFlowId = flowIdInput) => {
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
      setFlowIdInput(detail.flowId);
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
      await loadFlow(imported.flowId);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Package import failed.');
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
      <form
        className="flow-assets-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void loadFlow();
        }}
      >
        <label className="field">
          <span>Flow ID</span>
          <input
            aria-label="Flow ID"
            value={flowIdInput}
            onChange={(event) => setFlowIdInput(event.target.value)}
            placeholder="case_query"
          />
        </label>
        <button type="submit" className="command-button" disabled={busy}>
          Load flow
        </button>
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
            void loadFlow(flow.flowId);
          }}
          client={runtimeClient}
        />
      ) : null}
    </div>
  );
}

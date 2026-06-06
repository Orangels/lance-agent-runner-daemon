import type { CodegenArtifactSummary } from '../shared/codegen-types.js';

export interface DaemonHardeningPanelProps {
  daemonRunId?: string;
  logs: string[];
  artifacts: CodegenArtifactSummary[];
}

export function DaemonHardeningPanel({ daemonRunId, logs, artifacts }: DaemonHardeningPanelProps) {
  return (
    <div className="daemon-hardening-panel">
      <div className="daemon-hardening-panel__header">
        <h3>Daemon hardening</h3>
        <span>{daemonRunId ?? 'pending'}</span>
      </div>
      <div className="daemon-hardening-panel__grid">
        <div>
          <h4>Logs</h4>
          <ul className="compact-list" aria-label="Codegen logs">
            {logs.length === 0 ? <li>Waiting</li> : logs.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
          </ul>
        </div>
        <div>
          <h4>Artifacts</h4>
          <ul className="compact-list" aria-label="Generated artifacts">
            {artifacts.length === 0 ? (
              <li>Pending</li>
            ) : (
              artifacts.map((artifact) => <li key={artifact.artifactId}>{artifact.fileName}</li>)
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

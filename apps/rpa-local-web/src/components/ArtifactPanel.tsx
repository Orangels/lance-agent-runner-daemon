import type { RpaExecutionArtifactSummary } from '../shared/rpa-api-types.js';

export interface ArtifactPanelProps {
  executionId?: string;
  artifacts: RpaExecutionArtifactSummary[];
}

function safeFileName(fileName: string): string {
  const parts = fileName.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? 'artifact';
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ArtifactPanel({ executionId, artifacts }: ArtifactPanelProps) {
  return (
    <section className="rpa-artifact-panel" aria-label="Execution artifacts">
      <div className="rpa-artifact-panel__header">
        <h3>Artifacts</h3>
        <span className="rpa-artifact-panel__count">{artifacts.length}</span>
      </div>

      {artifacts.length === 0 ? (
        <p className="rpa-artifact-panel__empty">No artifacts yet.</p>
      ) : (
        <ul className="rpa-artifact-panel__items">
          {artifacts.map((artifact) => {
            const fileName = safeFileName(artifact.fileName);
            const href = executionId
              ? `/api/rpa/executions/${encodeURIComponent(executionId)}/artifacts/${encodeURIComponent(
                  artifact.artifactId,
                )}/download`
              : undefined;

            return (
              <li key={artifact.artifactId} className={`rpa-artifact-panel__item rpa-artifact-panel__item--${artifact.role}`}>
                <span className="rpa-artifact-panel__role">{artifact.role}</span>
                {href ? (
                  <a className="rpa-artifact-panel__link" href={href}>
                    {fileName}
                  </a>
                ) : (
                  <span className="rpa-artifact-panel__name">{fileName}</span>
                )}
                <span className="rpa-artifact-panel__size">{formatBytes(artifact.size)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

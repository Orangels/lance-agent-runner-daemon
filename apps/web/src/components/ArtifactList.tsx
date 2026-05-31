import { Download } from 'lucide-react';
import type { DemoArtifact } from '../chat/chat-types.js';

interface ArtifactListProps {
  artifacts: DemoArtifact[];
  onDownloadArtifact: (artifact: DemoArtifact) => void;
}

export function ArtifactList({ artifacts, onDownloadArtifact }: ArtifactListProps) {
  if (artifacts.length === 0) {
    return null;
  }

  return (
    <div className="artifact-list" aria-label="Artifacts">
      {artifacts.map((artifact) => (
        <div className="artifact-card" key={artifact.id}>
          <div>
            <strong>{artifact.fileName}</strong>
            <span>{artifact.relativePath}</span>
          </div>
          <button type="button" onClick={() => onDownloadArtifact(artifact)} aria-label={`Download ${artifact.fileName}`}>
            <Download size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

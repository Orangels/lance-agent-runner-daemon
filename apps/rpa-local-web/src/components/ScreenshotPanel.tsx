import { useEffect, useState } from 'react';

export interface ScreenshotBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotPanelProps {
  imageUrl?: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  errorMessage?: string;
  bbox?: ScreenshotBoundingBox;
}

export function ScreenshotPanel({ imageUrl, status, errorMessage, bbox }: ScreenshotPanelProps) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl, status]);

  const effectiveStatus = imageFailed ? 'error' : status;
  const effectiveError = imageFailed ? 'Screenshot failed to load.' : (errorMessage ?? 'Screenshot is unavailable.');

  return (
    <section className={`rpa-screenshot-panel rpa-screenshot-panel--${effectiveStatus}`} aria-label="Current screenshot">
      <div className="rpa-screenshot-panel__header">
        <h3>Screenshot</h3>
      </div>

      {effectiveStatus === 'idle' ? <p className="rpa-screenshot-panel__empty">No screenshot yet.</p> : null}
      {effectiveStatus === 'loading' ? <p className="rpa-screenshot-panel__loading">Loading screenshot...</p> : null}
      {effectiveStatus === 'error' ? <p className="rpa-screenshot-panel__error">{effectiveError}</p> : null}

      {effectiveStatus === 'ready' && imageUrl ? (
        <div className="rpa-screenshot-panel__stage">
          <img
            className="rpa-screenshot-panel__image"
            src={imageUrl}
            alt="Current execution screenshot"
            onError={() => setImageFailed(true)}
          />
          {bbox ? <div className="rpa-screenshot-panel__bbox" aria-hidden="true" /> : null}
        </div>
      ) : null}

      {effectiveStatus === 'ready' && !imageUrl ? (
        <p className="rpa-screenshot-panel__empty">No screenshot yet.</p>
      ) : null}
    </section>
  );
}

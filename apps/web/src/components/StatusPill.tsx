import type { RunStatus } from '../api/types.js';

interface StatusPillProps {
  status?: RunStatus | 'idle' | 'creating workspace' | 'uploading';
  label?: string;
}

export function StatusPill({ status, label }: StatusPillProps) {
  const text = label ?? status ?? 'idle';
  return <span className={`status-pill status-${String(text).replace(/\s+/g, '-')}`}>{text}</span>;
}

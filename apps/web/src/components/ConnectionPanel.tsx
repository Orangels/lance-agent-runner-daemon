import { KeyRound, PlugZap } from 'lucide-react';

interface ConnectionPanelProps {
  apiKey: string;
  baseUrl: string;
  healthStatus: 'idle' | 'checking' | 'ok' | 'error';
  profilesLoaded: boolean;
  onApiKeyChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onCheckHealth: () => void;
  onLoadProfiles: () => void;
}

export function ConnectionPanel({
  apiKey,
  baseUrl,
  healthStatus,
  profilesLoaded,
  onApiKeyChange,
  onBaseUrlChange,
  onCheckHealth,
  onLoadProfiles,
}: ConnectionPanelProps) {
  return (
    <section className="setup-section">
      <div className="section-title">
        <PlugZap size={16} aria-hidden="true" />
        <h2>Connection</h2>
      </div>
      <label>
        Daemon URL
        <input
          placeholder="Blank uses same-origin /api proxy"
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
        />
      </label>
      <label>
        API Key
        <input type="password" value={apiKey} onChange={(event) => onApiKeyChange(event.target.value)} />
      </label>
      <div className="setup-actions">
        <button type="button" onClick={onCheckHealth}>
          Health
        </button>
        <button type="button" onClick={onLoadProfiles}>
          <KeyRound size={14} aria-hidden="true" />
          Load profiles
        </button>
      </div>
      <p className={`setup-hint ${healthStatus === 'error' ? 'is-error' : ''}`}>
        Health: {healthStatus} · Profiles: {profilesLoaded ? 'loaded' : 'not loaded'}
      </p>
    </section>
  );
}

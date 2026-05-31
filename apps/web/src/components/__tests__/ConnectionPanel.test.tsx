import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionPanel } from '../ConnectionPanel.js';

describe('ConnectionPanel', () => {
  it('edits connection fields and triggers health/profile actions', async () => {
    const user = userEvent.setup();
    const onBaseUrlChange = vi.fn();
    const onApiKeyChange = vi.fn();
    const onCheckHealth = vi.fn();
    const onLoadProfiles = vi.fn();

    function Harness() {
      const [baseUrl, setBaseUrl] = useState('http://localhost:3000');
      const [apiKey, setApiKey] = useState('');
      return (
        <ConnectionPanel
          apiKey={apiKey}
          baseUrl={baseUrl}
          healthStatus="idle"
          onApiKeyChange={(value) => {
            setApiKey(value);
            onApiKeyChange(value);
          }}
          onBaseUrlChange={(value) => {
            setBaseUrl(value);
            onBaseUrlChange(value);
          }}
          onCheckHealth={onCheckHealth}
          onLoadProfiles={onLoadProfiles}
          profilesLoaded={false}
        />
      );
    }

    render(<Harness />);

    await user.clear(screen.getByLabelText('Daemon URL'));
    await user.type(screen.getByLabelText('Daemon URL'), 'http://daemon.test');
    await user.type(screen.getByLabelText('API Key'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Health' }));
    await user.click(screen.getByRole('button', { name: 'Load profiles' }));

    expect(onBaseUrlChange).toHaveBeenLastCalledWith('http://daemon.test');
    expect(onApiKeyChange).toHaveBeenLastCalledWith('secret');
    expect(onCheckHealth).toHaveBeenCalledTimes(1);
    expect(onLoadProfiles).toHaveBeenCalledTimes(1);
  });
});

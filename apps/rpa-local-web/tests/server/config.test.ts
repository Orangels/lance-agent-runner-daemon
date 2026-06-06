import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRpaLocalServerConfig } from '../../src/server/config.js';

describe('RPA local server config', () => {
  it('defaults storage root to an absolute .rpa-local directory', () => {
    const config = readRpaLocalServerConfig({});

    expect(path.isAbsolute(config.storageRoot)).toBe(true);
    expect(config.storageRoot).toBe(path.resolve('.rpa-local'));
  });

  it('allows RPA_LOCAL_STORAGE_ROOT to override execution storage', () => {
    const config = readRpaLocalServerConfig({
      RPA_LOCAL_STORAGE_ROOT: 'tmp/rpa-storage',
    });

    expect(config.storageRoot).toBe(path.resolve('tmp/rpa-storage'));
  });

  it('keeps existing server and daemon defaults', () => {
    const config = readRpaLocalServerConfig({});

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(5174);
    expect(config.daemonBaseUrl).toBe('http://127.0.0.1:17890');
    expect(config.daemonApiKey).toBe('local-dev-key');
    expect(config.defaultProfileId).toBe('rpa-local');
    expect(config.mode).toBe('development');
  });
});

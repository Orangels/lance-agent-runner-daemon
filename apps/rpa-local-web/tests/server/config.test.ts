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
    expect(config.codegenCommand).toBe('playwright');
    expect(config.codegenArgs).toEqual(['codegen']);
    expect(config.codegenStartTimeoutMs).toBeUndefined();
  });

  it('allows codegen env vars to override the default command, args, and start timeout', () => {
    const config = readRpaLocalServerConfig({
      RPA_CODEGEN_COMMAND: 'npx',
      RPA_CODEGEN_ARGS_JSON: '["playwright","codegen","--browser=chromium"]',
      RPA_CODEGEN_START_TIMEOUT_MS: '15000',
    });

    expect(config.codegenCommand).toBe('npx');
    expect(config.codegenArgs).toEqual(['playwright', 'codegen', '--browser=chromium']);
    expect(config.codegenStartTimeoutMs).toBe(15_000);
  });

  it('rejects codegen args JSON that is not a string array', () => {
    expect(() =>
      readRpaLocalServerConfig({
        RPA_CODEGEN_ARGS_JSON: '["codegen", 42]',
      }),
    ).toThrow('Invalid RPA_CODEGEN_ARGS_JSON: expected JSON string array');
  });

  it('rejects malformed codegen args JSON', () => {
    expect(() =>
      readRpaLocalServerConfig({
        RPA_CODEGEN_ARGS_JSON: 'not-json',
      }),
    ).toThrow('Invalid RPA_CODEGEN_ARGS_JSON: expected JSON string array');
  });

  it('rejects non-positive codegen start timeouts', () => {
    expect(() =>
      readRpaLocalServerConfig({
        RPA_CODEGEN_START_TIMEOUT_MS: '0',
      }),
    ).toThrow('Invalid RPA_CODEGEN_START_TIMEOUT_MS: expected positive integer');
  });

  it('rejects fractional codegen start timeouts', () => {
    expect(() =>
      readRpaLocalServerConfig({
        RPA_CODEGEN_START_TIMEOUT_MS: '100.5',
      }),
    ).toThrow('Invalid RPA_CODEGEN_START_TIMEOUT_MS: expected positive integer');
  });
});

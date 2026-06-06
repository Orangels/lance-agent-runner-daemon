import { describe, expect, it } from 'vitest';
import {
  isKnownToolStateArtifactPath,
  isSensitiveArtifactPath,
} from '../../src/shared/artifact-paths.js';

describe('artifact path helpers', () => {
  it('flags sensitive names anywhere inside a path segment', () => {
    expect(isSensitiveArtifactPath('output/db_secret.json')).toBe(true);
    expect(isSensitiveArtifactPath('output/api_token_helper.py')).toBe(true);
    expect(isSensitiveArtifactPath('output/my_credentials.json')).toBe(true);
    expect(isSensitiveArtifactPath('output/playwright_storage_state.json')).toBe(true);
  });

  it('does not flag ordinary supporting artifact names', () => {
    expect(isSensitiveArtifactPath('output/helpers/weather_parser.py')).toBe(false);
    expect(isSensitiveArtifactPath('helpers/weather.schema.json')).toBe(false);
  });

  it('flags tool state paths consistently', () => {
    expect(isKnownToolStateArtifactPath('output/__pycache__/flow.cpython-313.pyc', { outputPrefix: true })).toBe(true);
    expect(isKnownToolStateArtifactPath('__pycache__/flow.cpython-313.pyc')).toBe(true);
    expect(isKnownToolStateArtifactPath('output/helpers/weather_parser.py', { outputPrefix: true })).toBe(false);
  });
});

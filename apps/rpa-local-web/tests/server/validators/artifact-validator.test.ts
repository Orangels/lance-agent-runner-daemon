import { describe, expect, it } from 'vitest';
import { optionalGenerationArtifactNames, requiredGenerationArtifactNames } from '../../../src/shared/artifacts.js';
import { validateGenerationArtifacts } from '../../../src/server/validators/artifact-validator.js';

describe('RPA generation artifact validator', () => {
  const completeArtifacts = requiredGenerationArtifactNames.map((relativePath) => ({
    artifactId: `art_${relativePath}`,
    relativePath: `output/${relativePath}`,
    fileName: relativePath,
    mimeType: relativePath.endsWith('.json')
      ? 'application/json'
      : relativePath.endsWith('.py')
        ? 'text/x-python'
        : 'text/markdown',
    size: 128,
    sha256: 'a'.repeat(64),
  }));

  it('accepts the five required generation artifacts', () => {
    const result = validateGenerationArtifacts(completeArtifacts);

    expect(result.ok).toBe(true);
    expect(result.artifacts.map((artifact) => artifact.fileName)).toEqual(requiredGenerationArtifactNames);
  });

  it('rejects missing required artifacts with readable errors', () => {
    const result = validateGenerationArtifacts(completeArtifacts.slice(0, 3));

    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain('REQUIRED_ARTIFACT_MISSING');
    expect(result.errors.map((issue) => issue.message).join('\n')).toContain('parameterization-report.md');
  });

  it('rejects path traversal and unexpected artifact names', () => {
    const result = validateGenerationArtifacts([
      ...completeArtifacts,
      {
        artifactId: 'bad',
        relativePath: '../secrets/storage_state.json',
        fileName: 'storage_state.json',
        mimeType: 'application/json',
        size: 10,
        sha256: 'b'.repeat(64),
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['ARTIFACT_PATH_UNSAFE', 'UNEXPECTED_ARTIFACT']),
    );
  });

  it('rejects Windows-style path separators in artifact paths', () => {
    const result = validateGenerationArtifacts([
      ...completeArtifacts.map((artifact) =>
        artifact.fileName === 'flow.dsl.json'
          ? { ...artifact, relativePath: 'output\\flow.dsl.json' }
          : artifact,
      ),
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain('ARTIFACT_PATH_UNSAFE');
  });

  it('allows optional flow.py without blocking required artifact validation', () => {
    const result = validateGenerationArtifacts([
      ...completeArtifacts,
      {
        artifactId: 'art_flow_py',
        relativePath: 'output/flow.py',
        fileName: optionalGenerationArtifactNames[0],
        mimeType: 'text/x-python',
        size: 32,
        sha256: 'c'.repeat(64),
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.artifacts.map((artifact) => artifact.fileName)).toEqual([
      ...requiredGenerationArtifactNames,
      ...optionalGenerationArtifactNames,
    ]);
  });

  it('warns when sha256 is missing but still identifies artifact completeness', () => {
    const artifacts = completeArtifacts.map((artifact) =>
      artifact.fileName === 'flow.dsl.json' ? { ...artifact, sha256: undefined } : artifact,
    );

    const result = validateGenerationArtifacts(artifacts);

    expect(result.ok).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toContain('ARTIFACT_HASH_MISSING');
  });
});

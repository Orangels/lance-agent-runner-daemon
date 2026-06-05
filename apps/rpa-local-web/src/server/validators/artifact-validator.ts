import {
  type RpaGenerationArtifact,
  allowedGenerationArtifactNames,
  optionalGenerationArtifactNames,
  requiredGenerationArtifactNames,
} from '../../shared/artifacts.js';
import {
  type ValidationIssue,
  errorIssue,
  warningIssue,
} from './validation-types.js';

export interface GenerationArtifactValidationResult {
  ok: boolean;
  artifacts: RpaGenerationArtifact[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const allowedNameSet = new Set<string>(allowedGenerationArtifactNames);

export function validateGenerationArtifacts(
  artifacts: RpaGenerationArtifact[],
): GenerationArtifactValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const byFileName = new Map<string, RpaGenerationArtifact>();

  for (const artifact of artifacts) {
    const path = `artifacts.${artifact.fileName}`;
    if (!isSafeOutputArtifactPath(artifact.relativePath)) {
      errors.push(
        errorIssue(
          'ARTIFACT_PATH_UNSAFE',
          path,
          'Artifact path must stay under output/ and cannot contain traversal.',
        ),
      );
    }
    if (!allowedNameSet.has(artifact.fileName)) {
      errors.push(errorIssue('UNEXPECTED_ARTIFACT', path, `Unexpected generation artifact: ${artifact.fileName}.`));
    }
    if (artifact.size <= 0) {
      errors.push(errorIssue('ARTIFACT_EMPTY', path, `Artifact ${artifact.fileName} is empty.`));
    }
    if (artifact.sha256 === undefined) {
      warnings.push(warningIssue('ARTIFACT_HASH_MISSING', path, `Artifact ${artifact.fileName} has no sha256 hash.`));
    } else if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
      errors.push(errorIssue('ARTIFACT_HASH_INVALID', path, `Artifact ${artifact.fileName} has an invalid sha256 hash.`));
    }
    byFileName.set(artifact.fileName, artifact);
  }

  for (const requiredName of requiredGenerationArtifactNames) {
    if (!byFileName.has(requiredName)) {
      errors.push(
        errorIssue(
          'REQUIRED_ARTIFACT_MISSING',
          `artifacts.${requiredName}`,
          `Required generation artifact is missing: ${requiredName}.`,
        ),
      );
    }
  }

  return {
    ok: errors.length === 0,
    artifacts: [...requiredGenerationArtifactNames, ...optionalGenerationArtifactNames].flatMap((name) => {
      const artifact = byFileName.get(name);
      return artifact ? [artifact] : [];
    }),
    errors,
    warnings,
  };
}

function isSafeOutputArtifactPath(relativePath: string): boolean {
  return (
    relativePath.startsWith('output/') &&
    !relativePath.includes('..') &&
    !relativePath.startsWith('/') &&
    !relativePath.includes('\\')
  );
}

import {
  RPA_PACKAGE_SCHEMA_VERSION,
  requiredArtifactRoleByName,
  requiredGenerationArtifactNames,
  type RpaPackageManifest,
} from '../../shared/artifacts.js';
import { RPA_DSL_VERSION } from '../../shared/dsl-schema.js';
import { safeFlowId } from '../flow-store.js';

export class RpaPackageManifestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RpaPackageManifestError';
    this.code = code;
  }
}

export async function parseRpaPackageManifest(input: unknown): Promise<RpaPackageManifest> {
  if (!isRecord(input)) throw invalid('Manifest must be an object.');
  if (input.schemaVersion !== RPA_PACKAGE_SCHEMA_VERSION) {
    throw new RpaPackageManifestError('PACKAGE_SCHEMA_UNSUPPORTED', `Expected ${RPA_PACKAGE_SCHEMA_VERSION}.`);
  }
  if (typeof input.flowId !== 'string') throw invalid('flowId is required.');
  safeFlowId(input.flowId);
  if (typeof input.name !== 'string' || input.name.trim().length === 0) throw invalid('name is required.');
  if (typeof input.createdAt !== 'string') throw invalid('createdAt is required.');
  if (!isRecord(input.generator)) throw invalid('generator is required.');
  if (input.generator.mode !== 'codegen' && input.generator.mode !== 'nl' && input.generator.mode !== 'imported') {
    throw invalid('generator.mode is invalid.');
  }
  if (!isRecord(input.dsl) || input.dsl.version !== RPA_DSL_VERSION || input.dsl.path !== 'flow.dsl.json') {
    throw invalid('dsl descriptor is invalid.');
  }
  if (!isRecord(input.artifacts)) throw invalid('artifacts is required.');
  for (const [name, role] of Object.entries(requiredArtifactRoleByName)) {
    if (input.artifacts[role] !== name) {
      throw invalid(`artifact mapping for ${role} must be ${name}.`);
    }
  }
  if (!isRecord(input.checksums)) throw invalid('checksums is required.');
  for (const artifactName of requiredGenerationArtifactNames) {
    const checksum = input.checksums[artifactName];
    if (typeof checksum !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(checksum)) {
      throw invalid(`checksum is invalid for ${artifactName}.`);
    }
  }
  if (!isRecord(input.params) || input.params.schemaPath !== 'flow.dsl.json#/params') {
    throw invalid('params descriptor is invalid.');
  }
  if (!isRecord(input.requirements) || input.requirements.runtime !== 'python-playwright') {
    throw invalid('requirements descriptor is invalid.');
  }
  return input as unknown as RpaPackageManifest;
}

function invalid(message: string): RpaPackageManifestError {
  return new RpaPackageManifestError('PACKAGE_MANIFEST_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

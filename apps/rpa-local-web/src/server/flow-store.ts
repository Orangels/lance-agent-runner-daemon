import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
  RPA_PACKAGE_SCHEMA_VERSION,
  type RpaFlowLocalMetadata,
  type RpaPackageManifest,
  allowedGenerationArtifactNames,
  requiredGenerationArtifactNames,
} from '../shared/artifacts.js';
import { RPA_DSL_VERSION, type RpaDslDocument } from '../shared/dsl-schema.js';

export const FLOW_LOCAL_METADATA_FILE = 'flow.local.json' as const;

export function safeFlowId(flowId: string): string {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(flowId)) {
    throw new Error(`Invalid flow id: ${flowId}`);
  }
  return flowId;
}

export function resolveFlowsRoot(storageRoot: string): string {
  return path.join(path.resolve(storageRoot), 'flows');
}

export function resolveFlowDir(storageRoot: string, flowId: string): string {
  const flowsRoot = resolveFlowsRoot(storageRoot);
  const safeId = safeFlowId(flowId);
  const resolved = path.resolve(flowsRoot, safeId);
  if (!resolved.startsWith(`${flowsRoot}${path.sep}`)) {
    throw new Error(`Unsafe flow path: ${flowId}`);
  }
  return resolved;
}

export function resolveFlowArtifactPath(rootDir: string, flowId: string, artifactName: string): string {
  const safeId = safeFlowId(flowId);
  const flowDir = path.resolve(rootDir, safeId);
  const resolved = path.resolve(flowDir, artifactName);
  if (!resolved.startsWith(`${flowDir}${path.sep}`)) {
    throw new Error(`Unsafe artifact path: ${artifactName}`);
  }
  if (!allowedGenerationArtifactNames.includes(artifactName as never)) {
    throw new Error(`Unsupported flow artifact: ${artifactName}`);
  }
  return resolved;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readFlowLocalMetadata(
  flowDir: string,
  flowId: string,
): Promise<RpaFlowLocalMetadata> {
  try {
    const parsed = JSON.parse(await readFile(path.join(flowDir, FLOW_LOCAL_METADATA_FILE), 'utf8')) as RpaFlowLocalMetadata;
    if (parsed.schemaVersion !== RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION || parsed.flowId !== flowId) {
      throw new Error('Invalid flow local metadata.');
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        schemaVersion: RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
        flowId,
        source: 'generated',
        createdAt: new Date(0).toISOString(),
        requiresVerifyBeforeRun: false,
      };
    }
    throw error;
  }
}

export async function writeFlowLocalMetadata(
  flowDir: string,
  metadata: RpaFlowLocalMetadata,
): Promise<void> {
  await writeJsonFile(path.join(flowDir, FLOW_LOCAL_METADATA_FILE), metadata);
}

export async function markFlowVerified(input: {
  storageRoot: string;
  flowId: string;
  executionId: string;
  verifiedAt?: string;
}): Promise<RpaFlowLocalMetadata> {
  const flowDir = resolveFlowDir(input.storageRoot, input.flowId);
  const current = await readFlowLocalMetadata(flowDir, input.flowId);
  const updated: RpaFlowLocalMetadata = {
    ...current,
    requiresVerifyBeforeRun: false,
    verified: {
      executionId: input.executionId,
      verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    },
  };
  await writeFlowLocalMetadata(flowDir, updated);
  return updated;
}

export interface BuildRpaPackageManifestInput {
  flowDir: string;
  dsl: RpaDslDocument;
  generator: RpaPackageManifest['generator'];
}

export async function buildRpaPackageManifest(
  input: BuildRpaPackageManifestInput,
): Promise<RpaPackageManifest> {
  const checksums = {} as RpaPackageManifest['checksums'];
  for (const name of requiredGenerationArtifactNames) {
    checksums[name] = `sha256:${await sha256File(path.join(input.flowDir, name))}`;
  }

  return {
    schemaVersion: RPA_PACKAGE_SCHEMA_VERSION,
    flowId: input.dsl.flow_id,
    name: input.dsl.meta.title,
    createdAt: new Date().toISOString(),
    generator: input.generator,
    dsl: {
      version: RPA_DSL_VERSION,
      path: 'flow.dsl.json',
    },
    artifacts: {
      dsl: 'flow.dsl.json',
      script: 'flow.hardened.py',
      configTemplate: 'config.example.json',
      parameterizationReport: 'parameterization-report.md',
      hardeningReport: 'hardening-report.md',
    },
    params: {
      schemaPath: 'flow.dsl.json#/params',
      requiresUserInput: Object.values(input.dsl.params).some((param) => param.required === true),
      maskedParamIds: Object.entries(input.dsl.params)
        .filter(([, param]) => param.mask === true || param.type === 'secret')
        .map(([id]) => id),
    },
    requirements: {
      runtime: 'python-playwright',
      executorMinVersion: '0.1.0',
      browser: 'playwright-chromium',
      browserChannel: null,
      manualIntervention: input.dsl.steps
        .filter((step) => step.manual !== null)
        .map((step) => step.manual?.type ?? 'other'),
    },
    checksums,
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
  type RpaPackageManifest,
} from '../../shared/artifacts.js';
import type { RpaGenerationArtifact } from '../../shared/artifacts.js';
import type { ArtifactsResponse } from '../../shared/daemon-types.js';
import { resolveFlowsRoot, safeFlowId, writeFlowLocalMetadata } from '../flow-store.js';
import { validateGenerationArtifacts } from '../validators/artifact-validator.js';
import { validateRpaDsl } from '../validators/dsl-validator.js';

export interface GenerationArtifactDaemonClient {
  listRunArtifacts(runId: string): Promise<ArtifactsResponse>;
  downloadArtifact(input: { runId: string; artifactId: string }): Promise<Response>;
}

export interface PersistRequiredGenerationArtifactsInput {
  daemonClient: GenerationArtifactDaemonClient;
  storageRoot: string;
  flowId: string;
  runId: string;
  tempSuffix: string;
  generator: RpaPackageManifest['generator'];
}

export class GenerationArtifactError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GenerationArtifactError';
    this.code = code;
  }
}

function resolveFinalFlowDir(storageRoot: string, flowId: string): string {
  const flowsRoot = resolveFlowsRoot(storageRoot);
  const safeId = safeFlowId(flowId);
  const resolved = path.resolve(flowsRoot, safeId);
  if (!resolved.startsWith(`${flowsRoot}${path.sep}`)) {
    throw new GenerationArtifactError('FLOW_PATH_UNSAFE', `Unsafe final flow path: ${flowId}`);
  }
  return resolved;
}

export async function persistRequiredGenerationArtifacts(
  input: PersistRequiredGenerationArtifactsInput,
): Promise<RpaGenerationArtifact[]> {
  const artifactsResponse = await input.daemonClient.listRunArtifacts(input.runId);
  const generationArtifacts = artifactsResponse.artifacts
    .filter((artifact) => artifact.relativePath.startsWith('output/') && !isKnownToolStateArtifact(artifact.relativePath))
    .map((artifact): RpaGenerationArtifact => ({
      artifactId: artifact.id,
      relativePath: artifact.relativePath,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType ?? undefined,
      size: artifact.size ?? 0,
      sha256: artifact.sha256 ?? undefined,
    }));

  const artifactValidation = validateGenerationArtifacts(generationArtifacts);
  if (!artifactValidation.ok) {
    throw new GenerationArtifactError(
      'ARTIFACT_VALIDATION_FAILED',
      `Generated artifacts failed validation: ${artifactValidation.errors.map((issue) => issue.code).join(', ')}.`,
    );
  }

  const finalFlowDir = resolveFinalFlowDir(input.storageRoot, input.flowId);
  const tempFlowDir = `${finalFlowDir}.tmp-${input.tempSuffix}`;
  await rm(tempFlowDir, { recursive: true, force: true });
  await mkdir(tempFlowDir, { recursive: true });

  let promoted = false;
  try {
    for (const artifact of artifactValidation.artifacts) {
      const response = await input.daemonClient.downloadArtifact({
        runId: input.runId,
        artifactId: artifact.artifactId,
      });
      if (!response.ok) {
        throw new GenerationArtifactError(
          'ARTIFACT_DOWNLOAD_FAILED',
          `Failed to download generation artifact: ${artifact.fileName}.`,
        );
      }
      await writeFile(path.join(tempFlowDir, artifact.fileName), await response.text(), 'utf8');
    }

    const dsl = JSON.parse(await readFile(path.join(tempFlowDir, 'flow.dsl.json'), 'utf8')) as unknown;
    const dslValidation = validateRpaDsl(dsl);
    if (!dslValidation.ok) {
      throw new GenerationArtifactError(
        'DSL_INVALID',
        `Generated DSL failed validation: ${dslValidation.errors.map((issue) => issue.code).join(', ')}.`,
      );
    }

    await replaceFinalFlowDir(tempFlowDir, finalFlowDir);
    await writeFlowLocalMetadata(finalFlowDir, {
      schemaVersion: RPA_FLOW_LOCAL_METADATA_SCHEMA_VERSION,
      flowId: input.flowId,
      source: 'generated',
      createdAt: new Date().toISOString(),
      generator: input.generator,
      requiresVerifyBeforeRun: false,
    });
    promoted = true;
    return artifactValidation.artifacts;
  } finally {
    if (!promoted) {
      await rm(tempFlowDir, { recursive: true, force: true });
    }
  }
}

function isKnownToolStateArtifact(relativePath: string): boolean {
  return (
    relativePath.startsWith('output/.omc/') ||
    relativePath.startsWith('output/.config/') ||
    relativePath.startsWith('output/.claude/') ||
    relativePath.startsWith('output/.cache/')
  );
}

async function replaceFinalFlowDir(tempFlowDir: string, finalFlowDir: string): Promise<void> {
  const backupFlowDir = `${finalFlowDir}.backup-${Date.now()}`;
  let hasBackup = false;

  await rm(backupFlowDir, { recursive: true, force: true });
  try {
    await rename(finalFlowDir, backupFlowDir);
    hasBackup = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await rename(tempFlowDir, finalFlowDir);
    if (hasBackup) {
      await rm(backupFlowDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (hasBackup) {
      await rename(backupFlowDir, finalFlowDir).catch(() => undefined);
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

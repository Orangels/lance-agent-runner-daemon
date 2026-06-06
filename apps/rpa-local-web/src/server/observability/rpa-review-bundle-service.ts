import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  requiredGenerationArtifactNames,
  type RpaGenerationArtifact,
} from '../../shared/artifacts.js';
import type { RpaDslDocument } from '../../shared/dsl-schema.js';
import { resolveFlowArtifactPath, resolveFlowsRoot, safeFlowId } from '../flow-store.js';
import {
  buildArtifactValidationDocument,
  buildDslValidationDocument,
  buildRpaDiagnostics,
} from './rpa-diagnostics.js';
import { collectRpaExecutionMaterials, resolveExecutionDirForReview } from './rpa-execution-materials.js';
import type { RpaReviewBundleRequest } from './rpa-observability-types.js';
import {
  isRpaFeedbackCategory,
  type RpaRedactionOptions,
} from './rpa-observability-types.js';
import { redactRpaValue } from './rpa-redaction.js';
import { buildRpaSummaryMarkdown } from './rpa-summary.js';
import { appendZipEntries, readUncompressedZipEntries, type ReviewZipEntry } from './review-zip.js';

export interface RpaReviewBundleDaemonClient {
  downloadReviewBundle(runId: string): Promise<Response>;
  listRunFeedback(runId: string): Promise<{ feedback: Array<{ category: string; message: string; metadata?: unknown }> }>;
}

export interface RpaReviewBundleService {
  createReviewBundle(input: RpaReviewBundleRequest): Promise<{
    buffer: Buffer;
    fileName: string;
    mimeType: 'application/zip';
    size: number;
  }>;
}

export function createRpaReviewBundleService(input: {
  storageRoot: string;
  daemonClient: RpaReviewBundleDaemonClient;
}): RpaReviewBundleService {
  const storageRoot = path.resolve(input.storageRoot);
  const flowsRoot = resolveFlowsRoot(storageRoot);

  return {
    async createReviewBundle(request) {
      const flowId = safeFlowId(request.flowId);
      const daemonResponse = await input.daemonClient.downloadReviewBundle(request.daemonRunId);
      const daemonZip = Buffer.from(await daemonResponse.arrayBuffer());
      const daemonEntries = readUncompressedZipEntries(daemonZip);
      const collectionMode = parseCollectionMode(daemonEntries, request.collectionMode);
      const flow = await loadFlowArtifacts(flowsRoot, flowId);
      const redaction = await buildRedactionOptions({
        dsl: flow.dsl,
        executionIds: request.executionIds,
        storageRoot,
      });
      const executionMaterials = await collectRpaExecutionMaterials({
        storageRoot,
        executionIds: request.executionIds,
        collectionMode,
        redaction,
        includeSensitiveFiles: request.includeSensitiveFiles,
      });
      const diagnostics = buildRpaDiagnostics({
        dsl: flow.dsl,
        artifacts: flow.artifacts,
        executions: executionMaterials.executionRecords,
      });
      const feedback = await collectRpaFeedback(input.daemonClient, request.daemonRunId, redaction);
      const extensionEntries: ReviewZipEntry[] = [
        jsonEntry('extensions/rpa/extension-manifest.json', {
          extension: 'rpa',
          schemaVersion: '1.0',
          daemonRunId: request.daemonRunId,
          flowId,
          dslPath: 'artifacts/flow.dsl.json',
          scriptPath: 'artifacts/flow.hardened.py',
          executionIds: request.executionIds,
          largeFiles: executionMaterials.largeFiles,
        }),
        {
          path: 'extensions/rpa/rpa-summary.md',
          content: buildRpaSummaryMarkdown({
            flowId,
            daemonRunId: request.daemonRunId,
            dsl: flow.dsl,
            diagnostics,
            executionRecords: executionMaterials.executionRecords,
          }),
        },
        jsonEntry('extensions/rpa/rpa-diagnostics.json', diagnostics),
        jsonEntry('extensions/rpa/dsl-validation.json', buildDslValidationDocument(flow.dsl)),
        jsonEntry('extensions/rpa/artifact-validation.json', buildArtifactValidationDocument(flow.artifacts)),
        {
          path: 'extensions/rpa/feedback.jsonl',
          content: feedback.map((entry) => JSON.stringify(entry)).join('\n') + (feedback.length > 0 ? '\n' : ''),
        },
        ...executionMaterials.entries.map((entry) => ({
          ...entry,
          path: `extensions/rpa/${entry.path}`,
        })),
      ];

      const buffer = appendZipEntries(daemonZip, extensionEntries);
      return {
        buffer,
        fileName: `rpa_${flowId}_${request.daemonRunId}_review_bundle.zip`,
        mimeType: 'application/zip',
        size: buffer.byteLength,
      };
    },
  };
}

async function loadFlowArtifacts(
  flowsRoot: string,
  flowId: string,
): Promise<{ dsl: RpaDslDocument; artifacts: RpaGenerationArtifact[] }> {
  const dslPath = resolveFlowArtifactPath(flowsRoot, flowId, 'flow.dsl.json');
  const dsl = JSON.parse(await readFile(dslPath, 'utf8')) as RpaDslDocument;
  const artifacts = (
    await Promise.all(
      requiredGenerationArtifactNames.map(async (fileName) => {
        const artifactPath = resolveFlowArtifactPath(flowsRoot, flowId, fileName);
        const artifact = await readArtifactSummary(artifactPath, fileName);
        return artifact ? [artifact] : [];
      }),
    )
  ).flat();
  return { dsl, artifacts };
}

async function readArtifactSummary(
  artifactPath: string,
  fileName: RpaGenerationArtifact['fileName'],
): Promise<RpaGenerationArtifact | null> {
  try {
    const [fileStat, content] = await Promise.all([stat(artifactPath), readFile(artifactPath)]);
    return {
      artifactId: `artifact_${createHash('sha256').update(fileName).digest('hex').slice(0, 16)}`,
      fileName,
      relativePath: `output/${fileName}`,
      size: fileStat.size,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function buildRedactionOptions(input: {
  dsl: RpaDslDocument;
  executionIds: string[];
  storageRoot: string;
}): Promise<RpaRedactionOptions> {
  const maskedParamIds = Object.entries(input.dsl.params)
    .filter(([, param]) => param.mask === true || param.type === 'secret')
    .map(([paramId]) => paramId);
  const params: RpaRedactionOptions['params'] = {};
  for (const executionId of input.executionIds) {
    const executionDir = resolveExecutionDirForReview(input.storageRoot, executionId);
    const runParams = await readOptionalJson(path.join(executionDir, 'run.params.json'));
    if (isRecord(runParams)) {
      for (const [key, value] of Object.entries(runParams)) {
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          params[key] = value;
        }
      }
    }
  }
  return { storageRoot: input.storageRoot, maskedParamIds, params };
}

async function collectRpaFeedback(
  daemonClient: RpaReviewBundleDaemonClient,
  daemonRunId: string,
  redaction: RpaRedactionOptions,
): Promise<unknown[]> {
  const response = await daemonClient.listRunFeedback(daemonRunId);
  return response.feedback
    .filter((entry) => isRpaFeedbackCategory(entry.category))
    .filter((entry) => {
      const metadata = entry.metadata;
      return !isRecord(metadata) || metadata.source === undefined || metadata.source === 'rpa-local-web';
    })
    .map((entry) => redactRpaValue(entry, redaction));
}

function parseCollectionMode(
  daemonEntries: Array<{ path: string; content: Buffer }>,
  fallback: RpaReviewBundleRequest['collectionMode'],
): RpaReviewBundleRequest['collectionMode'] {
  const manifest = daemonEntries.find((entry) => entry.path === 'manifest.json');
  if (!manifest) {
    return fallback;
  }
  const parsed = JSON.parse(manifest.content.toString('utf8')) as unknown;
  if (isRecord(parsed) && isCollectionMode(parsed.collectionMode)) {
    return parsed.collectionMode;
  }
  return fallback;
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function jsonEntry(path: string, value: unknown): ReviewZipEntry {
  return { path, content: `${JSON.stringify(value, null, 2)}\n` };
}

function isCollectionMode(value: unknown): value is RpaReviewBundleRequest['collectionMode'] {
  return value === 'lite' || value === 'diagnostic' || value === 'review';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

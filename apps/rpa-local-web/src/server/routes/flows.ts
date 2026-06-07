import { readdir, readFile, rm } from 'node:fs/promises';
import type { Express, Response } from 'express';
import type {
  DeleteRpaFlowResponse,
  RpaFlowDetailResponse,
  RpaFlowListResponse,
  RpaFlowSummary,
  RpaValidationIssueSummary,
} from '../../shared/rpa-api-types.js';
import type { RpaDslDocument } from '../../shared/dsl-schema.js';
import { deriveRuntimeParamFields } from '../../shared/runtime-params.js';
import {
  readFlowLocalMetadata,
  resolveFlowDir,
  resolveFlowArtifactPath,
  resolveFlowsRoot,
  safeFlowId,
} from '../flow-store.js';
import { validateRpaDsl } from '../validators/dsl-validator.js';
import type { ValidationIssue } from '../validators/validation-types.js';

export interface RegisterFlowRoutesOptions {
  storageRoot: string;
}

class RpaFlowRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'RpaFlowRouteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function registerFlowRoutes(app: Express, options: RegisterFlowRoutesOptions): void {
  const flowsRoot = resolveFlowsRoot(options.storageRoot);

  app.get('/api/rpa/flows', async (_req, res) => {
    try {
      const payload: RpaFlowListResponse = {
        flows: await listFlowSummaries(options.storageRoot),
      };
      res.json(payload);
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.get('/api/rpa/flows/:flowId', async (req, res) => {
    try {
      const flowId = parseFlowId(req.params.flowId);
      const dslPath = resolveFlowArtifactPath(flowsRoot, flowId, 'flow.dsl.json');
      const dsl = await readDsl(dslPath);
      const validation = validateRpaDsl(dsl);

      if (!validation.ok) {
        throw new RpaFlowRouteError(
          'DSL_INVALID',
          `DSL validation failed: ${validation.errors.map((issue) => issue.code).join(', ')}.`,
        );
      }

      const safeDsl = redactDslForBrowser(dsl as RpaDslDocument);
      const flowDir = resolveFlowDir(options.storageRoot, flowId);
      const metadata = await readFlowLocalMetadata(flowDir, flowId);
      const fields = deriveRuntimeParamFields(safeDsl.params);
      const payload: RpaFlowDetailResponse = {
        flowId,
        title: safeDsl.meta.title,
        source: safeDsl.meta.source,
        dsl: safeDsl,
        warnings: validation.warnings.map(summarizeIssue),
        runtimeParams: {
          fields,
          requiresUserInput: fields.some((field) => field.required),
          maskedParamIds: fields.filter((field) => field.mask).map((field) => field.id),
        },
        provenance: {
          source: metadata.source,
          requiresVerifyBeforeRun: metadata.requiresVerifyBeforeRun,
          importedAt: metadata.source === 'imported' ? metadata.createdAt : undefined,
          originalFlowId: metadata.imported?.originalFlowId,
          packageCreatedAt: metadata.imported?.packageCreatedAt,
          packageSha256: metadata.imported?.packageSha256,
          verifiedAt: metadata.verified?.verifiedAt,
          verifiedExecutionId: metadata.verified?.executionId,
        },
      };
      res.json(payload);
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.delete('/api/rpa/flows/:flowId', async (req, res) => {
    try {
      const flowId = parseFlowId(req.params.flowId);
      await deleteFlowDirectory(options.storageRoot, flowId);
      const payload: DeleteRpaFlowResponse = { flowId, deleted: true };
      res.json(payload);
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });
}

async function listFlowSummaries(storageRoot: string): Promise<RpaFlowSummary[]> {
  const flowsRoot = resolveFlowsRoot(storageRoot);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(flowsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw new RpaFlowRouteError('FLOW_LIST_FAILED', 'Failed to list flows.');
  }

  const summaries: RpaFlowSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    let flowId: string;
    try {
      flowId = safeFlowId(entry.name);
    } catch {
      continue;
    }

    try {
      const dslPath = resolveFlowArtifactPath(flowsRoot, flowId, 'flow.dsl.json');
      const dsl = await readDsl(dslPath);
      const validation = validateRpaDsl(dsl);
      if (!validation.ok) continue;
      const safeDsl = dsl as RpaDslDocument;
      const metadata = await readFlowLocalMetadata(resolveFlowDir(storageRoot, flowId), flowId);
      summaries.push({
        flowId,
        title: safeDsl.meta.title,
        source: safeDsl.meta.source,
        requiresVerifyBeforeRun: metadata.requiresVerifyBeforeRun,
      });
    } catch {
      continue;
    }
  }

  return summaries.sort((left, right) => left.flowId.localeCompare(right.flowId));
}

function parseFlowId(input: string | undefined): string {
  try {
    return safeFlowId(input ?? '');
  } catch {
    throw new RpaFlowRouteError('INVALID_FLOW_ID', 'Invalid flow id.');
  }
}

async function readDsl(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new RpaFlowRouteError('DSL_JSON_INVALID', 'DSL JSON is invalid.');
    }
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new RpaFlowRouteError('FLOW_ARTIFACT_MISSING', 'Flow artifact is missing: flow.dsl.json.', 404);
    }
    throw new RpaFlowRouteError('FLOW_ARTIFACT_READ_FAILED', 'Failed to read flow artifact.');
  }
}

async function deleteFlowDirectory(storageRoot: string, flowId: string): Promise<void> {
  const flowDir = resolveFlowDir(storageRoot, flowId);
  try {
    await rm(flowDir, { recursive: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new RpaFlowRouteError('FLOW_NOT_FOUND', 'Flow not found.', 404);
    }
    throw new RpaFlowRouteError('FLOW_DELETE_FAILED', 'Failed to delete flow.');
  }
}

function redactDslForBrowser(dsl: RpaDslDocument): RpaDslDocument {
  if (dsl.context.storage_state === undefined) return dsl;
  return {
    ...dsl,
    context: {
      ...dsl.context,
      storage_state: '[configured]',
    },
  };
}

function summarizeIssue(issue: ValidationIssue): RpaValidationIssueSummary {
  return {
    severity: issue.severity,
    code: issue.code,
    path: issue.path,
    message: issue.message,
  };
}

function sendError(res: Response, error: unknown, storageRoot: string): void {
  const status = error instanceof RpaFlowRouteError ? error.statusCode : 500;
  const code = error instanceof RpaFlowRouteError ? error.code : 'INTERNAL_ERROR';
  const message =
    error instanceof Error ? sanitizeStorageRoot(error.message, storageRoot) : 'Internal server error.';
  res.status(status).json({ error: { code, message } });
}

function sanitizeStorageRoot(value: string, storageRoot: string): string {
  return value.split(storageRoot).join('[rpa-storage]');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

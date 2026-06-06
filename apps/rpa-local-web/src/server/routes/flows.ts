import { readFile } from 'node:fs/promises';
import type { Express, Response } from 'express';
import type {
  RpaFlowDetailResponse,
  RpaValidationIssueSummary,
} from '../../shared/rpa-api-types.js';
import type { RpaDslDocument } from '../../shared/dsl-schema.js';
import {
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
      const payload: RpaFlowDetailResponse = {
        flowId,
        title: safeDsl.meta.title,
        source: safeDsl.meta.source,
        dsl: safeDsl,
        warnings: validation.warnings.map(summarizeIssue),
      };
      res.json(payload);
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });
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

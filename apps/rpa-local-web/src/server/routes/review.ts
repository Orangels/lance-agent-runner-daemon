import type { Express, Response } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DaemonClient } from '../daemon-client.js';
import { resolveExecutionDirForReview } from '../observability/rpa-execution-materials.js';
import { resolveFlowArtifactPath, resolveFlowsRoot, safeFlowId } from '../flow-store.js';
import type { RpaReviewBundleService } from '../observability/rpa-review-bundle-service.js';
import { redactRpaText, redactRpaValue } from '../observability/rpa-redaction.js';
import type { RpaRedactionOptions } from '../observability/rpa-observability-types.js';
import type { RpaDslDocument } from '../../shared/dsl-schema.js';
import {
  isRpaFeedbackCategory,
  isRpaFeedbackSeverity,
  type CreateRpaFeedbackRequest,
} from '../../shared/rpa-api-types.js';
import { buildContentDisposition } from './http-utils.js';

export interface RegisterReviewRoutesOptions {
  daemonClient: Pick<DaemonClient, 'createRunFeedback'>;
  reviewBundleService: RpaReviewBundleService;
  storageRoot: string;
}

class RpaReviewRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'RpaReviewRouteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function registerReviewRoutes(app: Express, options: RegisterReviewRoutesOptions): void {
  app.get('/api/rpa/flows/:flowId/review-bundle/download', async (req, res) => {
    try {
      const daemonRunId = parseRequiredString(req.query.daemonRunId, 'daemonRunId');
      const executionIds = parseStringArray(req.query.executionId, 'executionId');
      validateExecutionIds(options.storageRoot, executionIds);
      const includeSensitiveFiles = parseOptionalBoolean(req.query.includeSensitiveFiles, 'includeSensitiveFiles');
      const bundle = await options.reviewBundleService.createReviewBundle({
        flowId: String(req.params.flowId ?? ''),
        daemonRunId,
        executionIds,
        includeSensitiveFiles,
        collectionMode: 'diagnostic',
      });

      res.setHeader('Content-Type', bundle.mimeType);
      res.setHeader('Content-Length', String(bundle.size));
      res.setHeader('Content-Disposition', buildContentDisposition(bundle.fileName));
      res.send(bundle.buffer);
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.post('/api/rpa/feedback', async (req, res) => {
    try {
      const request = parseFeedbackBody(req.body);
      const redaction = await buildFeedbackRedactionOptions(options.storageRoot, request);
      const metadata = redactRpaValue(
        {
          source: 'rpa-local-web',
          flowId: request.flowId,
          executionId: request.executionId,
          stepId: request.stepId,
          severity: request.severity,
          artifactPath: request.artifactPath,
          screenshotPath: request.screenshotPath,
        },
        redaction,
      );
      const feedback = await options.daemonClient.createRunFeedback({
        runId: request.daemonRunId,
        category: request.category,
        message: redactRpaText(request.message, redaction),
        metadata,
      });
      res.status(201).json(feedback);
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });
}

async function buildFeedbackRedactionOptions(
  storageRoot: string,
  request: CreateRpaFeedbackRequest,
): Promise<RpaRedactionOptions> {
  const maskedParamIds: string[] = [];
  const params: RpaRedactionOptions['params'] = {};
  if (request.flowId) {
    const flowId = safeFlowId(request.flowId);
    const dsl = JSON.parse(
      await readFile(resolveFlowArtifactPath(resolveFlowsRoot(storageRoot), flowId, 'flow.dsl.json'), 'utf8'),
    ) as RpaDslDocument;
    maskedParamIds.push(
      ...Object.entries(dsl.params)
        .filter(([, param]) => param.mask === true || param.type === 'secret')
        .map(([paramId]) => paramId),
    );
  }
  if (request.executionId) {
    const executionDir = validateExecutionId(storageRoot, request.executionId);
    const runParams = await readOptionalJson(path.join(executionDir, 'run.params.json'));
    if (isRecord(runParams)) {
      for (const [key, value] of Object.entries(runParams)) {
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          params[key] = value;
        }
      }
    }
  }
  return { storageRoot, maskedParamIds, params };
}

function validateExecutionIds(storageRoot: string, executionIds: string[]): void {
  for (const executionId of executionIds) {
    validateExecutionId(storageRoot, executionId);
  }
}

function validateExecutionId(storageRoot: string, executionId: string): string {
  try {
    return resolveExecutionDirForReview(storageRoot, executionId);
  } catch {
    throw new RpaReviewRouteError('INVALID_REQUEST', 'Invalid executionId.');
  }
}

function parseFeedbackBody(body: unknown): CreateRpaFeedbackRequest {
  if (!isRecord(body)) {
    throw new RpaReviewRouteError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  const daemonRunId = readRequiredString(body, 'daemonRunId');
  const category = readRequiredString(body, 'category');
  const severity = readRequiredString(body, 'severity');
  const message = readRequiredString(body, 'message');
  if (!isRpaFeedbackCategory(category)) {
    throw new RpaReviewRouteError('INVALID_REQUEST', 'Invalid RPA feedback category.');
  }
  if (!isRpaFeedbackSeverity(severity)) {
    throw new RpaReviewRouteError('INVALID_REQUEST', 'Invalid RPA feedback severity.');
  }
  return {
    daemonRunId,
    category,
    severity,
    message,
    flowId: readOptionalString(body, 'flowId'),
    executionId: readOptionalString(body, 'executionId'),
    stepId: readOptionalString(body, 'stepId'),
    artifactPath: readOptionalString(body, 'artifactPath'),
    screenshotPath: readOptionalString(body, 'screenshotPath'),
  };
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpaReviewRouteError('INVALID_REQUEST', `${field} is required.`);
  }
  return value;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : [];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.filter((item) => item.length > 0);
  }
  throw new RpaReviewRouteError('INVALID_REQUEST', `${field} must be a string or string array.`);
}

function parseOptionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined) {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new RpaReviewRouteError('INVALID_REQUEST', `${field} must be true or false.`);
}

function readRequiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpaReviewRouteError('INVALID_REQUEST', `${field} is required.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new RpaReviewRouteError('INVALID_REQUEST', `${field} must be a string.`);
  }
  return value;
}

function sendError(res: Response, error: unknown, storageRoot: string): void {
  const status = error instanceof RpaReviewRouteError ? error.statusCode : 500;
  const code = error instanceof RpaReviewRouteError ? error.code : 'INTERNAL_ERROR';
  const rawMessage = error instanceof Error ? error.message : 'Internal server error.';
  res.status(status).json({ error: { code, message: rawMessage.split(storageRoot).join('[rpa-storage]') } });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

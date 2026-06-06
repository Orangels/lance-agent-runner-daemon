import type { Express, Response } from 'express';
import type {
  RepairNaturalLanguageSessionRequest,
  StartNaturalLanguageSessionRequest,
  SubmitNaturalLanguageQuestionAnswersRequest,
} from '../../shared/natural-language-types.js';
import { safeFlowId } from '../flow-store.js';
import type { NaturalLanguageSessionStore } from '../natural-language/nl-session-store.js';
import type { NaturalLanguageGenerationWorkflow } from '../workflows/natural-language-generation-workflow.js';

export interface RegisterNaturalLanguageRoutesOptions {
  storageRoot: string;
  store: NaturalLanguageSessionStore;
  workflow: NaturalLanguageGenerationWorkflow;
}

class NaturalLanguageRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'NaturalLanguageRouteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function registerNaturalLanguageRoutes(
  app: Express,
  options: RegisterNaturalLanguageRoutesOptions,
): void {
  app.post('/api/rpa/nl/sessions', async (req, res) => {
    try {
      const request = parseStartBody(req.body);
      const session = await createSession(options.store, request);
      void options.workflow.startGeneration(session.sessionId).catch((error) =>
        markFailed(options.store, session.sessionId, routeErrorCode(error), routeErrorMessage(error)),
      );
      res.status(202).json(await options.store.getPublicSession(session.sessionId));
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.get('/api/rpa/nl/sessions/:sessionId', async (req, res) => {
    try {
      res.json(await options.store.getPublicSession(String(req.params.sessionId)));
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.post('/api/rpa/nl/sessions/:sessionId/question-form/answers', async (req, res) => {
    const sessionId = String(req.params.sessionId);
    try {
      const request = parseAnswersBody(req.body);
      void options.workflow.submitQuestionAnswers(sessionId, request).catch((error) =>
        markFailed(options.store, sessionId, routeErrorCode(error), routeErrorMessage(error)),
      );
      res.status(202).json(await options.store.getPublicSession(sessionId));
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.post('/api/rpa/nl/sessions/:sessionId/repair', async (req, res) => {
    const sessionId = String(req.params.sessionId);
    try {
      const request = parseRepairBody(req.body);
      void options.workflow.repairFromExecutionFailure(sessionId, request).catch((error) =>
        markFailed(options.store, sessionId, routeErrorCode(error), routeErrorMessage(error)),
      );
      res.status(202).json(await options.store.getPublicSession(sessionId));
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.post('/api/rpa/nl/sessions/:sessionId/cancel', async (req, res) => {
    const sessionId = String(req.params.sessionId);
    try {
      await options.workflow.cancel(sessionId);
      res.json(await options.store.getPublicSession(sessionId));
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });
}

async function createSession(
  store: NaturalLanguageSessionStore,
  request: StartNaturalLanguageSessionRequest,
) {
  try {
    return await store.createSession(request);
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) {
      throw new NaturalLanguageRouteError('FLOW_ALREADY_EXISTS', 'Flow already exists.', 409);
    }
    if (error instanceof Error && error.message.includes('Invalid flow id')) {
      throw new NaturalLanguageRouteError('INVALID_REQUEST', 'Invalid flow id.');
    }
    throw error;
  }
}

async function markFailed(
  store: NaturalLanguageSessionStore,
  sessionId: string,
  code: string,
  message: string,
): Promise<void> {
  await store.setError(sessionId, { code, message });
  const session = await store.getSession(sessionId);
  if (session.status !== 'cancelled' && session.status !== 'failed') {
    try {
      await store.transition(sessionId, 'failed');
    } catch {
      // Workflow may already have moved the session into a terminal state.
    }
  }
}

function parseStartBody(body: unknown): StartNaturalLanguageSessionRequest {
  if (!isRecord(body)) {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  if (typeof body.targetUrl !== 'string' || !isHttpUrl(body.targetUrl)) {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'targetUrl must be an http or https URL.');
  }
  if (typeof body.flowId !== 'string') {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'flowId is required.');
  }
  try {
    safeFlowId(body.flowId);
  } catch {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'Invalid flow id.');
  }
  if (typeof body.requirement !== 'string' || body.requirement.trim().length === 0) {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'requirement is required.');
  }
  if (body.flowName !== undefined && typeof body.flowName !== 'string') {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'flowName must be a string.');
  }
  if (body.businessConstraints !== undefined && typeof body.businessConstraints !== 'string') {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'businessConstraints must be a string.');
  }
  if (body.safetyNotes !== undefined && typeof body.safetyNotes !== 'string') {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'safetyNotes must be a string.');
  }
  return {
    targetUrl: body.targetUrl,
    flowId: body.flowId,
    flowName: body.flowName,
    requirement: body.requirement,
    businessConstraints: body.businessConstraints,
    safetyNotes: body.safetyNotes,
  };
}

function parseAnswersBody(body: unknown): SubmitNaturalLanguageQuestionAnswersRequest {
  if (!isRecord(body)) {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  if (typeof body.formId !== 'string') {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'formId is required.');
  }
  if (!isRecord(body.answers)) {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'answers must be a JSON object.');
  }
  return {
    formId: body.formId,
    answers: body.answers as SubmitNaturalLanguageQuestionAnswersRequest['answers'],
  };
}

function parseRepairBody(body: unknown): RepairNaturalLanguageSessionRequest {
  if (!isRecord(body)) {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  if (typeof body.executionId !== 'string' || body.executionId.trim().length === 0) {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'executionId is required.');
  }
  if (body.instruction !== undefined && typeof body.instruction !== 'string') {
    throw new NaturalLanguageRouteError('INVALID_REQUEST', 'instruction must be a string.');
  }
  return {
    executionId: body.executionId,
    instruction: body.instruction,
  };
}

function sendError(res: Response, error: unknown, storageRoot: string): void {
  const status = error instanceof NaturalLanguageRouteError ? error.statusCode : 500;
  const code = error instanceof NaturalLanguageRouteError ? error.code : routeErrorCode(error);
  const message = sanitizeStorageRoot(routeErrorMessage(error), storageRoot);
  res.status(status).json({ error: { code, message } });
}

function routeErrorCode(error: unknown): string {
  if (error instanceof NaturalLanguageRouteError) return error.code;
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'INTERNAL_ERROR';
}

function routeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Internal server error.';
}

function sanitizeStorageRoot(value: string, storageRoot: string): string {
  return value.split(storageRoot).join('[rpa-storage]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

import type { Express, Response } from 'express';
import type {
  StartCodegenSessionRequest,
  SubmitCodegenQuestionAnswersRequest,
} from '../../shared/codegen-types.js';
import { safeFlowId } from '../flow-store.js';
import type { PlaywrightCodegenHandle } from '../codegen/playwright-codegen-runner.js';
import type { CodegenSessionStore } from '../codegen/codegen-session-store.js';
import type { CodegenHardeningWorkflow } from '../workflows/codegen-hardening-workflow.js';

export interface CodegenRunner {
  start(input: {
    scriptPath: string;
    targetUrl: string;
    appendLog?: (entry: { stream: 'stdout' | 'stderr'; line: string }) => void;
  }): PlaywrightCodegenHandle;
}

export interface RegisterCodegenRoutesOptions {
  storageRoot: string;
  store: CodegenSessionStore;
  runner: CodegenRunner;
  workflow: CodegenHardeningWorkflow;
}

class CodegenRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'CodegenRouteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function registerCodegenRoutes(app: Express, options: RegisterCodegenRoutesOptions): void {
  const activeRecordings = new Map<string, PlaywrightCodegenHandle>();

  app.post('/api/rpa/codegen/sessions', async (req, res) => {
    try {
      const request = parseStartBody(req.body);
      const session = await createSession(options.store, request);
      const handle = options.runner.start({
        scriptPath: session.recording.absoluteInputPath,
        targetUrl: session.targetUrl,
        appendLog: (entry) => {
          void options.store.appendLog(session.sessionId, `${entry.stream}: ${entry.line}`);
        },
      });
      activeRecordings.set(session.sessionId, handle);
      await options.store.setRecording(session.sessionId);

      void handle.done
        .then(async (result) => {
          activeRecordings.delete(session.sessionId);
          if (result.status === 'cancelled') return;
          await options.store.transition(session.sessionId, 'completed');
          await options.workflow.startHardening(session.sessionId);
        })
        .catch(async (error) => {
          activeRecordings.delete(session.sessionId);
          await markFailed(options.store, session.sessionId, routeErrorCode(error), routeErrorMessage(error));
        });

      res.status(202).json(await options.store.getPublicSession(session.sessionId));
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.get('/api/rpa/codegen/sessions/:sessionId', async (req, res) => {
    try {
      res.json(await options.store.getPublicSession(String(req.params.sessionId)));
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.post('/api/rpa/codegen/sessions/:sessionId/cancel', async (req, res) => {
    const sessionId = String(req.params.sessionId);
    try {
      const active = activeRecordings.get(sessionId);
      if (active) {
        active.cancel();
        activeRecordings.delete(sessionId);
      }

      const session = await options.store.getSession(sessionId);
      if (session.status === 'recording') {
        await options.store.transition(sessionId, 'cancelled');
      } else {
        await options.workflow.cancel(sessionId);
      }
      res.json(await options.store.getPublicSession(sessionId));
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.post('/api/rpa/codegen/sessions/:sessionId/question-form/answers', async (req, res) => {
    try {
      const request = parseAnswersBody(req.body);
      const sessionId = String(req.params.sessionId);
      await options.workflow.submitQuestionAnswers(sessionId, request);
      res.status(202).json(await options.store.getPublicSession(sessionId));
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });
}

async function createSession(store: CodegenSessionStore, request: StartCodegenSessionRequest) {
  try {
    return await store.createSession(request);
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) {
      throw new CodegenRouteError('FLOW_ALREADY_EXISTS', 'Flow already exists.', 409);
    }
    if (error instanceof Error && error.message.includes('Invalid flow id')) {
      throw new CodegenRouteError('INVALID_REQUEST', 'Invalid flow id.');
    }
    throw error;
  }
}

async function markFailed(store: CodegenSessionStore, sessionId: string, code: string, message: string): Promise<void> {
  await store.setError(sessionId, { code, message });
  const session = await store.getSession(sessionId);
  if (session.status !== 'cancelled' && session.status !== 'failed') {
    try {
      await store.transition(sessionId, 'failed');
    } catch {
      // Terminal or transitional states may already have been handled by the workflow.
    }
  }
}

function parseStartBody(body: unknown): StartCodegenSessionRequest {
  if (!isRecord(body)) {
    throw new CodegenRouteError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  if (typeof body.targetUrl !== 'string' || !isHttpUrl(body.targetUrl)) {
    throw new CodegenRouteError('INVALID_REQUEST', 'targetUrl must be an http or https URL.');
  }
  if (typeof body.flowId !== 'string') {
    throw new CodegenRouteError('INVALID_REQUEST', 'flowId is required.');
  }
  try {
    safeFlowId(body.flowId);
  } catch {
    throw new CodegenRouteError('INVALID_REQUEST', 'Invalid flow id.');
  }
  if (body.flowName !== undefined && typeof body.flowName !== 'string') {
    throw new CodegenRouteError('INVALID_REQUEST', 'flowName must be a string.');
  }
  return {
    targetUrl: body.targetUrl,
    flowId: body.flowId,
    flowName: body.flowName,
  };
}

function parseAnswersBody(body: unknown): SubmitCodegenQuestionAnswersRequest {
  if (!isRecord(body)) {
    throw new CodegenRouteError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  if (typeof body.formId !== 'string') {
    throw new CodegenRouteError('INVALID_REQUEST', 'formId is required.');
  }
  if (!isRecord(body.answers)) {
    throw new CodegenRouteError('INVALID_REQUEST', 'answers must be a JSON object.');
  }
  return {
    formId: body.formId,
    answers: body.answers as SubmitCodegenQuestionAnswersRequest['answers'],
  };
}

function sendError(res: Response, error: unknown, storageRoot: string): void {
  const status = error instanceof CodegenRouteError ? error.statusCode : 500;
  const code = error instanceof CodegenRouteError ? error.code : routeErrorCode(error);
  const message = sanitizeStorageRoot(routeErrorMessage(error), storageRoot);
  res.status(status).json({ error: { code, message } });
}

function routeErrorCode(error: unknown): string {
  if (error instanceof CodegenRouteError) return error.code;
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

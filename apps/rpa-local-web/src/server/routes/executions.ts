import type { Express, Request, Response } from 'express';
import type { StartExecutionInput, RpaLocalExecutor } from '../executor/python-playwright-executor.js';
import { RpaExecutorError } from '../executor/python-playwright-executor.js';
import { formatSseEvent } from '../executor/execution-events.js';

export function registerExecutionRoutes(app: Express, executor: RpaLocalExecutor): void {
  app.post('/api/rpa/executions', async (req, res) => {
    try {
      const input = parseStartExecutionBody(req.body);
      const payload = await executor.start(input);
      res.status(202).json(payload);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/rpa/executions/:executionId', async (req, res) => {
    try {
      res.json(await executor.getStatus(req.params.executionId));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/rpa/executions/:executionId/cancel', async (req, res) => {
    try {
      res.json(await executor.cancel(req.params.executionId));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/rpa/executions/:executionId/events', async (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const iterator = executor.subscribe(req.params.executionId)[Symbol.asyncIterator]();
    let closed = false;
    const closeIterator = () => {
      closed = true;
      void iterator.return?.();
    };
    req.on('close', closeIterator);
    res.on('close', closeIterator);

    try {
      while (!closed) {
        const result = await iterator.next();
        if (result.done || closed) break;
        const event = result.value;
        if (res.destroyed) break;
        res.write(formatSseEvent(event));
      }
      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    } catch (error) {
      if (!res.destroyed) {
        res.write(formatSseEvent(errorEvent(req.params.executionId, error)));
        res.end();
      }
    } finally {
      req.off('close', closeIterator);
      res.off('close', closeIterator);
      void iterator.return?.();
    }
  });

  app.get('/api/rpa/executions/:executionId/logs', async (req, res) => {
    try {
      res.json(await executor.getLogs(req.params.executionId));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/rpa/executions/:executionId/screenshots/current', async (req, res) => {
    try {
      const current = await executor.resolveCurrentScreenshot(req.params.executionId);
      if (!current) {
        sendError(res, new RpaExecutorError('SCREENSHOT_NOT_FOUND', 'Current screenshot not found.', 404));
        return;
      }
      res.sendFile(current.filePath);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/rpa/executions/:executionId/artifacts', async (req, res) => {
    try {
      res.json(await executor.listArtifacts(req.params.executionId));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/rpa/executions/:executionId/artifacts/:artifactId/download', async (req, res) => {
    try {
      const download = await executor.resolveArtifactDownload(req.params.executionId, req.params.artifactId);
      res.download(download.filePath, download.artifact.fileName);
    } catch (error) {
      sendError(res, error);
    }
  });
}

function parseStartExecutionBody(body: unknown): StartExecutionInput {
  if (!isRecord(body)) {
    throw new RpaExecutorError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  if (typeof body.flowId !== 'string') {
    throw new RpaExecutorError('INVALID_REQUEST', 'flowId is required.');
  }
  if (body.mode !== 'verify' && body.mode !== 'run') {
    throw new RpaExecutorError('INVALID_REQUEST', 'mode must be verify or run.');
  }
  if (body.daemonRunId !== undefined && typeof body.daemonRunId !== 'string') {
    throw new RpaExecutorError('INVALID_REQUEST', 'daemonRunId must be a string.');
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    throw new RpaExecutorError('INVALID_REQUEST', 'dryRun must be a boolean.');
  }
  if (body.headless !== undefined && typeof body.headless !== 'boolean') {
    throw new RpaExecutorError('INVALID_REQUEST', 'headless must be a boolean.');
  }
  if (body.timeoutMs !== undefined && typeof body.timeoutMs !== 'number') {
    throw new RpaExecutorError('INVALID_REQUEST', 'timeoutMs must be a number.');
  }
  if (body.params !== undefined && !isParamRecord(body.params)) {
    throw new RpaExecutorError('INVALID_REQUEST', 'params must be a JSON object with scalar values.');
  }

  return {
    flowId: body.flowId,
    daemonRunId: body.daemonRunId,
    mode: body.mode,
    dryRun: body.dryRun,
    headless: body.headless,
    timeoutMs: body.timeoutMs,
    params: body.params,
  };
}

function sendError(res: Response, error: unknown): void {
  const status = error instanceof RpaExecutorError ? error.statusCode : 500;
  const code = error instanceof RpaExecutorError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : 'Internal server error.';
  res.status(status).json({ error: { code, message } });
}

function errorEvent(executionId: string, error: unknown) {
  const code = error instanceof RpaExecutorError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : 'Execution event stream failed.';
  return {
    type: 'run.completed' as const,
    executionId,
    timestamp: new Date().toISOString(),
    status: 'failed' as const,
    message: `${code}: ${message}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParamRecord(value: unknown): value is StartExecutionInput['params'] {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean',
  );
}

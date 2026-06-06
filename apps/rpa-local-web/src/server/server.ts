import express, { type Express } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import type {
  RpaConfigResponse,
  RpaDaemonHealthResponse,
  RpaHealthResponse,
} from '../shared/rpa-api-types.js';
import { DaemonClient } from './daemon-client.js';
import type { RpaLocalServerConfig } from './config.js';
import { createCodegenSessionStore } from './codegen/codegen-session-store.js';
import { createPlaywrightCodegenRunner } from './codegen/playwright-codegen-runner.js';
import {
  createPythonPlaywrightExecutor,
  type PythonPlaywrightExecutorOptions,
  type RpaLocalExecutor,
} from './executor/python-playwright-executor.js';
import { registerCodegenRoutes } from './routes/codegen.js';
import { registerExecutionRoutes } from './routes/executions.js';
import { registerFlowRoutes } from './routes/flows.js';
import {
  createCodegenHardeningWorkflow,
  type CodegenHardeningWorkflow,
} from './workflows/codegen-hardening-workflow.js';

export interface CreateRpaLocalServerInput {
  config: RpaLocalServerConfig;
  daemonFetch?: typeof fetch;
  executor?: RpaLocalExecutor;
  executorOptions?: Pick<PythonPlaywrightExecutorOptions, 'pythonCommand' | 'pythonArgs' | 'defaultTimeoutMs'>;
  codegenWorkflow?: CodegenHardeningWorkflow;
}

export async function createRpaLocalServer(input: CreateRpaLocalServerInput): Promise<Express> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const daemonClient = new DaemonClient({
    baseUrl: input.config.daemonBaseUrl,
    apiKey: input.config.daemonApiKey,
    fetchImpl: input.daemonFetch,
  });
  const executor =
    input.executor ??
    createPythonPlaywrightExecutor({
      storageRoot: input.config.storageRoot,
      ...input.executorOptions,
    });
  const codegenStore = createCodegenSessionStore({ storageRoot: input.config.storageRoot });
  const codegenRunner = createPlaywrightCodegenRunner({
    command: input.config.codegenCommand,
    args: input.config.codegenArgs,
    storageRoot: input.config.storageRoot,
  });
  const codegenWorkflow =
    input.codegenWorkflow ??
    createCodegenHardeningWorkflow({
      daemonClient,
      defaultProfileId: input.config.defaultProfileId,
      storageRoot: input.config.storageRoot,
      store: codegenStore,
    });

  app.get('/api/rpa/health', (_req, res) => {
    const payload: RpaHealthResponse = { ok: true, app: 'rpa-local-web' };
    res.json(payload);
  });

  app.get('/api/rpa/config', (_req, res) => {
    const payload: RpaConfigResponse = {
      defaultProfileId: input.config.defaultProfileId,
      daemonConfigured: input.config.daemonBaseUrl.trim().length > 0,
    };
    res.json(payload);
  });

  app.get('/api/rpa/daemon/health', async (_req, res) => {
    try {
      await daemonClient.getHealth();
      const payload: RpaDaemonHealthResponse = {
        ok: true,
        daemonReachable: true,
        status: 200,
      };
      res.json(payload);
    } catch (error) {
      const payload: RpaDaemonHealthResponse = {
        ok: false,
        daemonReachable: false,
        error: error instanceof Error ? sanitizeHealthError(error.message) : 'Unknown daemon health error',
      };
      res.status(502).json(payload);
    }
  });

  app.locals.daemonClient = daemonClient;
  app.locals.rpaExecutor = executor;
  registerFlowRoutes(app, { storageRoot: input.config.storageRoot });
  registerCodegenRoutes(app, {
    storageRoot: input.config.storageRoot,
    store: codegenStore,
    runner: codegenRunner,
    workflow: codegenWorkflow,
  });
  registerExecutionRoutes(app, executor);

  if (input.config.mode === 'development') {
    const vite = await createViteMiddleware();
    app.use(vite.middlewares);
  } else if (input.config.mode === 'production') {
    const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
    app.use(express.static(clientDist));
    app.get('/*splat', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}

async function createViteMiddleware(): Promise<ViteDevServer> {
  const { createServer } = await import('vite');
  return createServer({
    appType: 'spa',
    server: { middlewareMode: true },
  });
}

function sanitizeHealthError(message: string): string {
  return message.replace(/https?:\/\/[^/\s]+/g, '[daemon]');
}

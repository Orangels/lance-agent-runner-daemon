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

export interface CreateRpaLocalServerInput {
  config: RpaLocalServerConfig;
  daemonFetch?: typeof fetch;
}

export async function createRpaLocalServer(input: CreateRpaLocalServerInput): Promise<Express> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const daemonClient = new DaemonClient({
    baseUrl: input.config.daemonBaseUrl,
    apiKey: input.config.daemonApiKey,
    fetchImpl: input.daemonFetch,
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

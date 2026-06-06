import express, { type Express, type Response } from 'express';
import { exportRpaPackage, importRpaPackage, RpaPackageError } from '../packages/rpa-package.js';

export interface RegisterPackageRoutesOptions {
  storageRoot: string;
}

export function registerPackageRoutes(app: Express, options: RegisterPackageRoutesOptions): void {
  app.get('/api/rpa/flows/:flowId/package/download', async (req, res) => {
    try {
      const result = await exportRpaPackage({
        storageRoot: options.storageRoot,
        flowId: String(req.params.flowId ?? ''),
      });
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.status(200).send(result.content);
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });

  app.post('/api/rpa/flows/import-package', expressRawZipBody(), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
        throw new RpaPackageError('PACKAGE_BODY_REQUIRED', 'Package body must be zip bytes.');
      }

      const result = await importRpaPackage({
        storageRoot: options.storageRoot,
        packageFileName: readPackageFileName(req.headers['x-rpa-package-file-name']),
        content: req.body,
      });
      res.status(201).json(result);
    } catch (error) {
      sendError(res, error, options.storageRoot);
    }
  });
}

function expressRawZipBody() {
  return express.raw({
    type: ['application/zip', 'application/octet-stream', 'application/x-rpa-package'],
    limit: '20mb',
  });
}

function readPackageFileName(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return 'imported.rpa.zip';
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'imported.rpa.zip';
}

function sendError(res: Response, error: unknown, storageRoot: string): void {
  const status = error instanceof RpaPackageError ? error.statusCode : 500;
  const code = error instanceof RpaPackageError ? error.code : 'INTERNAL_ERROR';
  const rawMessage = error instanceof Error ? error.message : 'Internal server error.';
  const message = rawMessage.split(storageRoot).join('[rpa-storage]');
  res.status(status).json({ error: { code, message } });
}

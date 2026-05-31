import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { authenticateClient } from '../config/auth.js';
import type { ClientConfig, DaemonConfig } from '../config/profiles.js';

export interface AuthenticatedRequest extends Request {
  client: ClientConfig;
}

export function requireAuth(config: DaemonConfig): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction) => {
    try {
      (request as AuthenticatedRequest).client = authenticateClient(
        request.headers as Record<string, string | string[] | undefined>,
        config.clients,
      );
      next();
    } catch (error) {
      next(error);
    }
  };
}

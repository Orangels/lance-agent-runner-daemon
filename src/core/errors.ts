import type { DaemonErrorCode, ErrorResponse } from './run-types.js';

export class DaemonError extends Error {
  public readonly code: DaemonErrorCode;
  public readonly status: number;
  public readonly details?: unknown;

  public constructor(code: DaemonErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): DaemonError {
  return new DaemonError('BAD_REQUEST', message, 400, details);
}

export function unauthorized(message: string, details?: unknown): DaemonError {
  return new DaemonError('UNAUTHORIZED', message, 401, details);
}

export function forbidden(message: string, details?: unknown): DaemonError {
  return new DaemonError('FORBIDDEN', message, 403, details);
}

export function notFound(message: string, details?: unknown): DaemonError {
  return new DaemonError('NOT_FOUND', message, 404, details);
}

export function internalError(message = 'Internal server error', details?: unknown): DaemonError {
  return new DaemonError('INTERNAL_ERROR', message, 500, details);
}

export function daemonError(
  code: DaemonErrorCode,
  message: string,
  status: number,
  details?: unknown,
): DaemonError {
  return new DaemonError(code, message, status, details);
}

export function toErrorResponse(error: DaemonError): ErrorResponse {
  const body: ErrorResponse = {
    error: {
      code: error.code,
      message: error.message,
    },
  };

  if (error.details !== undefined) {
    body.error.details = error.details;
  }

  return body;
}

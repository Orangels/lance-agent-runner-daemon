import { describe, expect, it } from 'vitest';
import {
  daemonErrorCodes,
  eventVisibilityLevels,
  isTerminalRunStatus,
  runMessageFlushPolicy,
  runStatuses,
  workspaceDirectoryNames,
} from '../run-types.js';
import { DaemonError, badRequest, forbidden, notFound, toErrorResponse } from '../errors.js';

describe('run contract constants', () => {
  it('defines the first-version run statuses exactly', () => {
    expect(runStatuses).toEqual([
      'queued',
      'running',
      'succeeded',
      'failed',
      'canceled',
      'interrupted',
    ]);
  });

  it('identifies terminal run statuses', () => {
    expect(isTerminalRunStatus('queued')).toBe(false);
    expect(isTerminalRunStatus('running')).toBe(false);
    expect(isTerminalRunStatus('succeeded')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('canceled')).toBe(true);
    expect(isTerminalRunStatus('interrupted')).toBe(true);
  });

  it('defines event visibility levels exactly', () => {
    expect(eventVisibilityLevels).toEqual(['quiet', 'normal', 'debug']);
  });

  it('defines the workspace directory skeleton exactly', () => {
    expect(workspaceDirectoryNames).toEqual([
      'input',
      'output',
      'work',
      '.claude-runner-skills',
    ]);
  });

  it('defines the daemon-side run message flush policy', () => {
    expect(runMessageFlushPolicy).toEqual({
      throttleMs: 500,
      createUserAndAssistantDraftOnRunCreate: true,
      forceFlushBeforeTerminalTransition: true,
      preserveLastSuccessfulPartialWriteAfterCrash: true,
    });
  });

  it('exports the required structured error codes', () => {
    expect(daemonErrorCodes).toEqual([
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'MODEL_NOT_ALLOWED',
      'PROFILE_NOT_ALLOWED',
      'SKILL_NOT_ALLOWED',
      'RUN_QUEUE_FULL',
      'WORKSPACE_RUN_ACTIVE',
      'RUN_NOT_CANCELABLE',
      'RUN_TIMEOUT',
      'RUN_INACTIVITY_TIMEOUT',
      'ARTIFACT_REQUIRED_MISSING',
      'RUN_INTERRUPTED_BY_DAEMON_RESTART',
      'CLAUDE_AUTH_FAILED',
      'CLAUDE_CLI_FAILED',
      'INTERNAL_ERROR',
      'PATH_NOT_ALLOWED',
      'INVALID_PATH_SEGMENT',
    ]);
  });
});

describe('daemon errors', () => {
  it('builds structured error responses', () => {
    const error = badRequest('Invalid run request', { field: 'kind' });

    expect(error).toBeInstanceOf(DaemonError);
    expect(toErrorResponse(error)).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid run request',
        details: { field: 'kind' },
      },
    });
  });

  it('sets default HTTP statuses for common helpers', () => {
    expect(notFound('Missing').status).toBe(404);
    expect(forbidden('No access').status).toBe(403);
  });
});

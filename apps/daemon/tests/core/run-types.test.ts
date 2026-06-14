import { describe, expect, it } from 'vitest';
import {
  daemonErrorCodes,
  collectionModes,
  eventVisibilityLevels,
  isTerminalRunStatus,
  promptModes,
  runMessageFlushPolicy,
  runStatuses,
  workspaceDirectoryNames,
} from '../../src/core/run-types.js';
import { DaemonError, badRequest, forbidden, notFound, toErrorResponse } from '../../src/core/errors.js';

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

  it('defines prompt and collection modes exactly', () => {
    expect(promptModes).toEqual(['legacy', 'business-context', 'daemon-composed']);
    expect(collectionModes).toEqual(['lite', 'diagnostic', 'review']);
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
      'SKILL_UNAVAILABLE',
      'SKILL_STAGING_FAILED',
      'PROMPT_COMPOSITION_FAILED',
      'IDEMPOTENCY_KEY_CONFLICT',
      'RUN_QUEUE_FULL',
      'WORKSPACE_RUN_ACTIVE',
      'RUN_NOT_CANCELABLE',
      'RUN_TIMEOUT',
      'RUN_INACTIVITY_TIMEOUT',
      'ARTIFACT_REQUIRED_MISSING',
      'ARTIFACT_SCAN_FAILED',
      'RUN_INTERRUPTED_BY_DAEMON_RESTART',
      'CLAUDE_AUTH_FAILED',
      'CLAUDE_CLI_FAILED',
      'COLLECTION_MODE_NOT_ALLOWED',
      'REVIEW_BUNDLE_TOO_LARGE',
      'INTERNAL_ERROR',
      'PATH_NOT_ALLOWED',
      'INVALID_PATH_SEGMENT',
    ]);
  });

  it('includes idempotency conflict in public error codes', () => {
    expect(daemonErrorCodes).toContain('IDEMPOTENCY_KEY_CONFLICT');
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

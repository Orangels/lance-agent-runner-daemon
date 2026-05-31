import type { DaemonErrorCode } from './run-types.js';

export type ClaudeCliFailureCategory = 'auth' | 'model' | 'config' | 'spawn' | 'unknown';

export interface ClaudeCliDiagnosticInput {
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string | null;
  stdout?: string | null;
  spawnError?: unknown;
  claudeConfigDir?: string | null;
}

export interface ClaudeCliDiagnostic {
  code: Extract<DaemonErrorCode, 'CLAUDE_AUTH_FAILED' | 'CLAUDE_CLI_FAILED'>;
  message: string;
  details: {
    category: ClaudeCliFailureCategory;
  };
}

function combinedOutput(input: ClaudeCliDiagnosticInput): string {
  return [input.stderr, input.stdout]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
}

function classifyClaudeCliFailure(input: ClaudeCliDiagnosticInput): ClaudeCliFailureCategory {
  if (input.spawnError) return 'spawn';

  const output = combinedOutput(input);

  if (
    /\b(?:401|403)\b/.test(output) ||
    /api\s*key.*(?:invalid|missing|not found|expired)/i.test(output) ||
    /(?:auth|oauth|credential|token).*(?:fail|invalid|missing|expired|not found|unauthorized)/i.test(
      output,
    ) ||
    /(?:unauthorized|forbidden|could not authenticate|authentication failed)/i.test(output)
  ) {
    return 'auth';
  }

  if (
    /selected model is not available/i.test(output) ||
    /current plan or region/i.test(output) ||
    /model.*(?:not available|not supported|unsupported|not found|no access|does not have access)/i.test(
      output,
    )
  ) {
    return 'model';
  }

  if (
    /(?:config|profile|session|credential|oauth).*(?:stale|corrupt|expired|missing|not found|invalid)/i.test(
      output,
    ) ||
    /(?:stale|corrupt|expired|missing|not found|invalid).*(?:config|profile|session|credential|oauth)/i.test(
      output,
    )
  ) {
    return 'config';
  }

  return 'unknown';
}

export function diagnoseClaudeCliFailure(
  input: ClaudeCliDiagnosticInput,
): ClaudeCliDiagnostic | null {
  if (!input.spawnError && input.exitCode === 0 && !input.signal) return null;

  const category = classifyClaudeCliFailure(input);
  const code = category === 'auth' ? 'CLAUDE_AUTH_FAILED' : 'CLAUDE_CLI_FAILED';
  const message =
    category === 'auth' ? 'Claude CLI authentication failed.' : 'Claude CLI failed.';

  return {
    code,
    message,
    details: { category },
  };
}

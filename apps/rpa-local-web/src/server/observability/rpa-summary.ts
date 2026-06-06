import type { RpaDslDocument } from '../../shared/dsl-schema.js';

interface SummaryDiagnostics {
  missingArtifacts?: string[];
  fragileSelectors?: Array<{ stepId: string; selectorType: string; path: string }>;
  parameterizationIssues?: Array<{ field: string; message: string }>;
  missingWaits?: string[];
  missingAsserts?: string[];
  unconfirmedWriteSteps?: string[];
  executionFailures?: Array<{ executionId: string; stepId?: string; category: string; message: string }>;
}

interface SummaryExecutionRecord {
  executionId: string;
  status: string;
  failedStepId?: string;
}

export function buildRpaSummaryMarkdown(input: {
  flowId: string;
  daemonRunId: string;
  dsl: RpaDslDocument;
  diagnostics: SummaryDiagnostics;
  executionRecords: SummaryExecutionRecord[];
}): string {
  return [
    '# RPA Review Summary',
    '',
    '## Flow',
    `Flow: ${input.flowId}`,
    `Title: ${input.dsl.meta.title}`,
    `Source: ${input.dsl.meta.source}`,
    `Daemon run: ${input.daemonRunId}`,
    '',
    '## Generation',
    'See the daemon review-summary.md, prompt-snapshot.md, and skill snapshot for generation context.',
    '',
    '## DSL And Artifacts',
    listOrNone('Missing artifacts', input.diagnostics.missingArtifacts),
    `Step count: ${input.dsl.steps.length}`,
    '',
    '## Parameterization',
    `Param count: ${Object.keys(input.dsl.params).length}`,
    listObjects('Issues', input.diagnostics.parameterizationIssues, (issue) => `${issue.field}: ${issue.message}`),
    '',
    '## Selector Wait Assert Risk',
    listObjects(
      'Fragile selectors',
      input.diagnostics.fragileSelectors,
      (item) => `${item.stepId}: ${item.selectorType} at ${item.path}`,
    ),
    listOrNone('Missing waits', input.diagnostics.missingWaits),
    listOrNone('Missing asserts', input.diagnostics.missingAsserts),
    listOrNone('Unconfirmed write steps', input.diagnostics.unconfirmedWriteSteps),
    '',
    '## Executions',
    listObjects(
      'Execution records',
      input.executionRecords,
      (execution) => `${execution.executionId}: ${execution.status}${execution.failedStepId ? ` at ${execution.failedStepId}` : ''}`,
    ),
    listObjects(
      'Execution failures',
      input.diagnostics.executionFailures,
      (failure) => `${failure.executionId}${failure.stepId ? `/${failure.stepId}` : ''}: ${failure.message}`,
    ),
    '',
    '## Suggested Skill Improvements',
    suggestSkillImprovements(input.diagnostics).join('\n'),
    '',
    '## Files To Inspect Next',
    '- extensions/rpa/rpa-diagnostics.json',
    '- extensions/rpa/dsl-validation.json',
    '- extensions/rpa/artifact-validation.json',
    '- extensions/rpa/executions/*/execution.json',
    '- extensions/rpa/executions/*/execution-log.jsonl',
    '',
  ].join('\n');
}

function listOrNone(label: string, items: string[] | undefined): string {
  if (!items || items.length === 0) {
    return `${label}: none`;
  }
  return [`${label}:`, ...items.slice(0, 10).map((item) => `- ${item}`)].join('\n');
}

function listObjects<T>(label: string, items: T[] | undefined, format: (item: T) => string): string {
  if (!items || items.length === 0) {
    return `${label}: none`;
  }
  return [`${label}:`, ...items.slice(0, 10).map((item) => `- ${format(item)}`)].join('\n');
}

function suggestSkillImprovements(diagnostics: SummaryDiagnostics): string[] {
  const suggestions: string[] = [];
  if ((diagnostics.missingArtifacts?.length ?? 0) > 0) {
    suggestions.push('- Tighten artifact checklist instructions in the active RPA skill.');
  }
  if ((diagnostics.fragileSelectors?.length ?? 0) > 0) {
    suggestions.push('- Prefer role/label/testid selectors before css/xpath fallback.');
  }
  if ((diagnostics.missingWaits?.length ?? 0) > 0 || (diagnostics.missingAsserts?.length ?? 0) > 0) {
    suggestions.push('- Strengthen wait/assert requirements in script generation or hardening templates.');
  }
  if ((diagnostics.parameterizationIssues?.length ?? 0) > 0) {
    suggestions.push('- Ask Claude Code to promote fixed business values into DSL params.');
  }
  if ((diagnostics.executionFailures?.length ?? 0) > 0) {
    suggestions.push('- Use execution failure step ids and logs to update selector/wait repair guidance.');
  }
  return suggestions.length > 0 ? suggestions : ['- No immediate RPA skill changes suggested by the summary.'];
}

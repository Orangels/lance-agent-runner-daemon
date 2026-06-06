import {
  requiredGenerationArtifactNames,
  type RpaGenerationArtifact,
} from '../../shared/artifacts.js';
import type {
  RpaDslDocument,
  RpaDslManual,
  RpaDslStep,
  RpaDslTarget,
} from '../../shared/dsl-schema.js';
import type { RpaExecutionRecord } from '../executor/execution-types.js';
import { validateGenerationArtifacts } from '../validators/artifact-validator.js';
import { validateRpaDsl } from '../validators/dsl-validator.js';

export interface RpaDiagnostics {
  schemaVersion: 'rpa-diagnostics.v0.1';
  limits: {
    maxItemsPerList: number;
    omitted: Record<string, number>;
  };
  missingArtifacts: string[];
  schemaErrors: string[];
  schemaWarnings: string[];
  fragileSelectors: Array<{ stepId: string; selectorType: string; path: string }>;
  missingWaits: string[];
  missingAsserts: string[];
  manualSteps: Array<{ stepId: string; type: string; reason: string }>;
  unconfirmedWriteSteps: string[];
  parameterizationIssues: Array<{ field: string; message: string }>;
  executionFailures: Array<{
    executionId: string;
    stepId?: string;
    category: 'selector' | 'executor';
    message: string;
  }>;
}

interface BuildRpaDiagnosticsInput {
  dsl: unknown;
  artifacts: RpaGenerationArtifact[];
  executions: RpaExecutionRecord[];
  maxItemsPerList?: number;
}

const actionsNeedingWait = new Set(['navigate', 'click', 'input', 'select', 'submit']);
const actionsNeedingAssert = new Set(['submit', 'assert']);

export function buildRpaDiagnostics(input: BuildRpaDiagnosticsInput): RpaDiagnostics {
  const maxItemsPerList = input.maxItemsPerList ?? 20;
  const omitted: Record<string, number> = {};
  const dslValidation = validateRpaDsl(input.dsl);
  const artifactValidation = validateGenerationArtifacts(input.artifacts);
  const dsl = dslValidation.ok && isRpaDslDocument(input.dsl) ? input.dsl : null;

  const missingArtifacts = requiredGenerationArtifactNames.filter(
    (name) => !input.artifacts.some((artifact) => artifact.fileName === name),
  );
  const fragileSelectors = dsl ? findFragileSelectors(dsl) : [];
  const missingWaits = dsl ? findMissingWaits(dsl) : [];
  const missingAsserts = dsl ? findMissingAsserts(dsl) : [];
  const manualSteps = dsl ? findManualSteps(dsl) : [];
  const unconfirmedWriteSteps = dsl ? findUnconfirmedWriteSteps(dsl) : [];
  const parameterizationIssues = dsl ? findParameterizationIssues(dsl) : [];
  const executionFailures = input.executions
    .filter((execution) => ['failed', 'timed_out', 'canceled'].includes(execution.status))
    .map((execution) => ({
      executionId: execution.executionId,
      stepId: execution.failedStepId,
      category: execution.error?.code.toLowerCase().includes('target') ? 'selector' as const : 'executor' as const,
      message: execution.error?.message ?? `Execution ended with status ${execution.status}.`,
    }));

  return {
    schemaVersion: 'rpa-diagnostics.v0.1',
    limits: {
      maxItemsPerList,
      omitted,
    },
    missingArtifacts: cap('missingArtifacts', missingArtifacts, maxItemsPerList, omitted),
    schemaErrors: cap('schemaErrors', dslValidation.errors.map(formatIssue), maxItemsPerList, omitted),
    schemaWarnings: cap(
      'schemaWarnings',
      [...dslValidation.warnings.map(formatIssue), ...artifactValidation.warnings.map(formatIssue)],
      maxItemsPerList,
      omitted,
    ),
    fragileSelectors: cap('fragileSelectors', fragileSelectors, maxItemsPerList, omitted),
    missingWaits: cap('missingWaits', missingWaits, maxItemsPerList, omitted),
    missingAsserts: cap('missingAsserts', missingAsserts, maxItemsPerList, omitted),
    manualSteps: cap('manualSteps', manualSteps, maxItemsPerList, omitted),
    unconfirmedWriteSteps: cap('unconfirmedWriteSteps', unconfirmedWriteSteps, maxItemsPerList, omitted),
    parameterizationIssues: cap('parameterizationIssues', parameterizationIssues, maxItemsPerList, omitted),
    executionFailures: cap('executionFailures', executionFailures, maxItemsPerList, omitted),
  };
}

export function buildDslValidationDocument(input: unknown): unknown {
  return {
    schemaVersion: 'rpa-dsl-validation.v0.1',
    ...validateRpaDsl(input),
  };
}

export function buildArtifactValidationDocument(artifacts: RpaGenerationArtifact[]): unknown {
  return {
    schemaVersion: 'rpa-artifact-validation.v0.1',
    ...validateGenerationArtifacts(artifacts),
  };
}

function findFragileSelectors(dsl: RpaDslDocument): Array<{ stepId: string; selectorType: string; path: string }> {
  return dsl.steps.flatMap((step, index) => {
    if (!isFragileTarget(step.target)) {
      return [];
    }
    return [{ stepId: step.id, selectorType: step.target.by, path: `steps[${index}].target` }];
  });
}

function findMissingWaits(dsl: RpaDslDocument): string[] {
  return dsl.steps
    .filter((step) => actionsNeedingWait.has(step.action) && step.wait === undefined)
    .map((step) => step.id);
}

function findMissingAsserts(dsl: RpaDslDocument): string[] {
  return dsl.steps
    .filter((step) => actionsNeedingAssert.has(step.action) && (!step.assert || step.assert.length === 0))
    .map((step) => step.id);
}

function findManualSteps(dsl: RpaDslDocument): Array<{ stepId: string; type: string; reason: string }> {
  return dsl.steps.flatMap((step) =>
    step.manual
      ? [{ stepId: step.id, type: step.manual.type, reason: step.manual.instruction }]
      : [],
  );
}

function findUnconfirmedWriteSteps(dsl: RpaDslDocument): string[] {
  return dsl.steps
    .filter((step) => step.write === true && !step.idempotency_key && !hasHighRiskManual(step.manual))
    .map((step) => step.id);
}

function findParameterizationIssues(dsl: RpaDslDocument): Array<{ field: string; message: string }> {
  if (Object.keys(dsl.params).length > 0) {
    return [];
  }
  return [
    {
      field: 'params',
      message: 'No runtime params were defined; fixed business values may not have been parameterized.',
    },
  ];
}

function isFragileTarget(target: RpaDslTarget | undefined): target is RpaDslTarget {
  return target?.by === 'css' || target?.by === 'xpath';
}

function hasHighRiskManual(manual: RpaDslManual | null): boolean {
  return manual?.riskLevel === 'high';
}

function cap<T>(key: string, items: T[], maxItems: number, omitted: Record<string, number>): T[] {
  if (items.length <= maxItems) {
    return items;
  }
  omitted[key] = items.length - maxItems;
  return items.slice(0, maxItems);
}

function formatIssue(issue: { path: string; code: string; message: string }): string {
  return `${issue.path}: ${issue.code} - ${issue.message}`;
}

function isRpaDslDocument(value: unknown): value is RpaDslDocument {
  return isRecord(value) && Array.isArray(value.steps) && isRecord(value.params);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

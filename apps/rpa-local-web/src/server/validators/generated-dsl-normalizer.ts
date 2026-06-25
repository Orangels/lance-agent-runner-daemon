import {
  type ValidationIssue,
  warningIssue,
} from './validation-types.js';

export interface GeneratedDslCanonicalizationResult {
  dsl: unknown;
  warnings: ValidationIssue[];
}

export function canonicalizeGeneratedRpaDsl(input: unknown): GeneratedDslCanonicalizationResult {
  const dsl = structuredClone(input);
  const warnings: ValidationIssue[] = [];

  if (!isRecord(dsl) || !Array.isArray(dsl.steps)) {
    return { dsl, warnings };
  }

  dsl.steps.forEach((step, stepIndex) => {
    if (!isRecord(step) || !Array.isArray(step.assert)) {
      return;
    }

    step.assert = step.assert.map((assertion, assertionIndex) =>
      canonicalizeAssertion(assertion, `steps[${stepIndex}].assert[${assertionIndex}]`, warnings),
    );
  });

  return { dsl, warnings };
}

function canonicalizeAssertion(
  assertion: unknown,
  path: string,
  warnings: ValidationIssue[],
): unknown {
  if (!isRecord(assertion) || typeof assertion.type !== 'string') {
    return assertion;
  }

  const rawType = assertion.type;
  const normalizedType = rawType.trim().toLowerCase();
  if (
    normalizedType === 'min_count' &&
    typeof assertion.value === 'number' &&
    Number.isInteger(assertion.value) &&
    assertion.value > 0
  ) {
    warnings.push(
      warningIssue(
        'ASSERT_TYPE_NORMALIZED',
        `${path}.type`,
        'Normalized generated assertion type min_count to row_count_gt.',
      ),
    );
    return { ...assertion, type: 'row_count_gt', value: assertion.value - 1 };
  }

  const alias = safeAssertTypeAliases[normalizedType];
  if (alias) {
    warnings.push(
      warningIssue(
        'ASSERT_TYPE_NORMALIZED',
        `${path}.type`,
        `Normalized generated assertion type ${rawType} to ${alias}.`,
      ),
    );
    return { ...assertion, type: alias };
  }

  return assertion;
}

const safeAssertTypeAliases: Record<string, string> = {
  text_includes: 'text_contains',
  text_include: 'text_contains',
  contains_text: 'text_contains',
  url_includes: 'url_contains',
  url_include: 'url_contains',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

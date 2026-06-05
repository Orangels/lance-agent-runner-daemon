import {
  RPA_DSL_VERSION,
  type RpaDslDocument,
  type RpaDslParamDefinition,
  type RpaDslStep,
  rpaDslActionValues,
  rpaDslAssertTypeValues,
  rpaDslParamTypeValues,
  rpaDslTargetByValues,
} from '../../shared/dsl-schema.js';
import {
  type ValidationIssue,
  type ValidationResult,
  errorIssue,
  warningIssue,
} from './validation-types.js';

export interface ParameterFormField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'password';
  required: boolean;
  mask: boolean;
  options?: { label: string; value: string }[];
  defaultValue?: string | number | boolean;
}

const actionsRequiringTarget = new Set(['click', 'input', 'select', 'submit', 'assert']);
const actionsNeedingWaitWarning = new Set(['navigate', 'click', 'input', 'select', 'submit']);
const actionsNeedingAssertWarning = new Set(['submit', 'assert']);

export function validateRpaDsl(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [errorIssue('DSL_NOT_OBJECT', '', 'DSL must be a JSON object.')],
      warnings,
    };
  }

  if (input.dsl_version !== RPA_DSL_VERSION) {
    errors.push(errorIssue('UNSUPPORTED_DSL_VERSION', 'dsl_version', `Expected ${RPA_DSL_VERSION}.`));
  }
  if (!isFlowId(input.flow_id)) {
    errors.push(
      errorIssue('INVALID_FLOW_ID', 'flow_id', 'flow_id must use lowercase letters, numbers, and underscores.'),
    );
  }
  if (!isRecord(input.meta)) {
    errors.push(errorIssue('META_REQUIRED', 'meta', 'meta must be an object.'));
  }
  if (!isRecord(input.params)) {
    errors.push(errorIssue('PARAMS_REQUIRED', 'params', 'params must be an object.'));
  } else {
    validateParams(input.params, errors);
  }
  if (!isRecord(input.context)) {
    errors.push(errorIssue('CONTEXT_REQUIRED', 'context', 'context must be an object.'));
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push(errorIssue('STEPS_REQUIRED', 'steps', 'steps must be a non-empty array.'));
  } else {
    const seenStepIds = new Set<string>();
    input.steps.forEach((step, index) => validateStep(step, index, seenStepIds, errors, warnings));
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function deriveParameterFormModel(dsl: RpaDslDocument): ParameterFormField[] {
  return Object.entries(dsl.params).map(([id, param]) => ({
    id,
    label: param.label ?? id,
    type: mapParamTypeToFormType(param),
    required: param.required === true,
    mask: param.mask === true || param.type === 'secret',
    options: param.options,
    defaultValue: param.default,
  }));
}

function validateParams(params: Record<string, unknown>, errors: ValidationIssue[]) {
  for (const [key, value] of Object.entries(params)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      errors.push(
        errorIssue(
          'INVALID_PARAM_ID',
          `params.${key}`,
          'Parameter ids must use lowercase letters, numbers, and underscores.',
        ),
      );
      continue;
    }
    if (!isRecord(value)) {
      errors.push(errorIssue('INVALID_PARAM', `params.${key}`, 'Parameter definition must be an object.'));
      continue;
    }
    if (!includesString(rpaDslParamTypeValues, value.type)) {
      errors.push(errorIssue('UNSUPPORTED_PARAM_TYPE', `params.${key}.type`, 'Unsupported parameter type.'));
    }
    if (value.type === 'select' && !Array.isArray(value.options)) {
      errors.push(errorIssue('SELECT_REQUIRES_OPTIONS', `params.${key}.options`, 'Select parameters require options.'));
    }
  }
}

function validateStep(
  value: unknown,
  index: number,
  seenStepIds: Set<string>,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
) {
  const path = `steps[${index}]`;
  if (!isRecord(value)) {
    errors.push(errorIssue('INVALID_STEP', path, 'Step must be an object.'));
    return;
  }

  const step = value as Partial<RpaDslStep>;
  if (typeof step.id !== 'string' || step.id.length === 0) {
    errors.push(errorIssue('STEP_ID_REQUIRED', `${path}.id`, 'Step id is required.'));
  } else {
    if (seenStepIds.has(step.id)) {
      errors.push(errorIssue('DUPLICATE_STEP_ID', `${path}.id`, `Duplicate step id: ${step.id}.`));
    } else {
      seenStepIds.add(step.id);
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(step.id)) {
      errors.push(
        errorIssue(
          'INVALID_STEP_ID',
          `${path}.id`,
          'Step id must be lowercase, stable, and match ^[a-z][a-z0-9_]{0,63}$.',
        ),
      );
    }
  }
  if (typeof step.name !== 'string' || step.name.length === 0) {
    errors.push(errorIssue('STEP_NAME_REQUIRED', `${path}.name`, 'Step name is required.'));
  }
  if (!includesString(rpaDslActionValues, step.action)) {
    errors.push(errorIssue('UNSUPPORTED_ACTION', `${path}.action`, 'Unsupported step action.'));
    return;
  }
  if (typeof step.write !== 'boolean') {
    errors.push(errorIssue('STEP_WRITE_REQUIRED', `${path}.write`, 'Step write flag is required.'));
  }
  if (!('manual' in step)) {
    errors.push(errorIssue('STEP_MANUAL_REQUIRED', `${path}.manual`, 'Step manual field is required, use null when not needed.'));
  }

  if (actionsRequiringTarget.has(step.action) && !isRecord(step.target)) {
    errors.push(errorIssue('STEP_TARGET_REQUIRED', `${path}.target`, 'This action requires a target.'));
  }
  if (isRecord(step.target)) {
    validateTarget(step.target, `${path}.target`, errors, warnings);
  }
  if (Array.isArray(step.assert)) {
    step.assert.forEach((assertion, assertionIndex) => {
      if (!isRecord(assertion) || !includesString(rpaDslAssertTypeValues, assertion.type)) {
        errors.push(
          errorIssue(
            'UNSUPPORTED_ASSERT_TYPE',
            `${path}.assert[${assertionIndex}].type`,
            'Unsupported assertion type.',
          ),
        );
      }
    });
  }
  if (step.manual !== null && step.manual !== undefined) {
    validateManual(step.manual, `${path}.manual`, errors);
  }

  if (actionsNeedingWaitWarning.has(step.action) && step.wait === undefined) {
    warnings.push(warningIssue('MISSING_WAIT', `${path}.wait`, 'Actionable step should define explicit wait conditions.'));
  }
  if (actionsNeedingAssertWarning.has(step.action) && (!Array.isArray(step.assert) || step.assert.length === 0)) {
    warnings.push(warningIssue('MISSING_ASSERT', `${path}.assert`, 'Critical step should define a result assertion.'));
  }
  if (step.write === true && !step.idempotency_key && !hasHighRiskManual(step.manual)) {
    warnings.push(
      warningIssue(
        'WRITE_MISSING_IDEMPOTENCY_OR_MANUAL_CONFIRMATION',
        `${path}.write`,
        'Write steps should provide idempotency_key or high-risk manual confirmation.',
      ),
    );
  }
}

function validateManual(value: unknown, path: string, errors: ValidationIssue[]) {
  if (!isRecord(value)) {
    errors.push(errorIssue('INVALID_MANUAL', path, 'Manual field must be null or an object.'));
    return;
  }
  if (!['captcha', 'login', 'ca_usbkey', 'confirm', 'other'].includes(String(value.type))) {
    errors.push(errorIssue('UNSUPPORTED_MANUAL_TYPE', `${path}.type`, 'Unsupported manual intervention type.'));
  }
  if (typeof value.instruction !== 'string' || value.instruction.trim().length === 0) {
    errors.push(
      errorIssue('MANUAL_INSTRUCTION_REQUIRED', `${path}.instruction`, 'Manual intervention requires an instruction.'),
    );
  }
}

function validateTarget(
  target: Record<string, unknown>,
  path: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
) {
  if (!includesString(rpaDslTargetByValues, target.by)) {
    errors.push(errorIssue('UNSUPPORTED_TARGET_BY', `${path}.by`, 'Unsupported target selector type.'));
    return;
  }
  if (target.by === 'xpath') {
    warnings.push(warningIssue('XPATH_FALLBACK', `${path}.by`, 'XPath is a fallback selector and should be hardened later.'));
  }
}

function mapParamTypeToFormType(param: RpaDslParamDefinition): ParameterFormField['type'] {
  if (param.type === 'number') return 'number';
  if (param.type === 'date') return 'date';
  if (param.type === 'boolean') return 'checkbox';
  if (param.type === 'select') return 'select';
  if (param.type === 'secret') return 'password';
  return 'text';
}

function hasHighRiskManual(value: unknown): boolean {
  return isRecord(value) && value.riskLevel === 'high';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function includesString(values: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && values.includes(value);
}

function isFlowId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(value);
}

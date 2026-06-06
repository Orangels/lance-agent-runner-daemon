import type { RpaDslParamDefinition } from './dsl-schema.js';

export type RuntimeParamValue = string | number | boolean | null;

export interface RpaRuntimeParamField {
  id: string;
  label: string;
  description?: string;
  type: 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'password';
  required: boolean;
  mask: boolean;
  options?: { label: string; value: string }[];
  defaultValue?: string | number | boolean;
}

export interface RuntimeParamValidationError {
  paramId: string;
  code: 'PARAM_REQUIRED' | 'PARAM_TYPE_INVALID' | 'PARAM_OPTION_INVALID' | 'PARAM_UNSUPPORTED';
  message: string;
}

export type RuntimeParamValidationResult =
  | { ok: true; value: Record<string, RuntimeParamValue>; errors: [] }
  | { ok: false; value: Record<string, RuntimeParamValue>; errors: RuntimeParamValidationError[] };

export function deriveRuntimeParamFields(
  params: Record<string, RpaDslParamDefinition>,
): RpaRuntimeParamField[] {
  return Object.entries(params).map(([id, param]) => ({
    id,
    label: param.label ?? id,
    description: param.description,
    type: mapParamTypeToFieldType(param),
    required: param.required === true,
    mask: param.mask === true || param.type === 'secret',
    options: param.options,
    defaultValue: param.default,
  }));
}

export function normalizeRuntimeParams(
  definitions: Record<string, RpaDslParamDefinition>,
  input: Record<string, RuntimeParamValue | undefined>,
): RuntimeParamValidationResult {
  const value: Record<string, RuntimeParamValue> = {};
  const errors: RuntimeParamValidationError[] = [];

  for (const [paramId, definition] of Object.entries(definitions)) {
    const raw = input[paramId] ?? definition.default;
    const normalized = normalizeOneParam(paramId, definition, raw);
    if (normalized.ok) {
      if (normalized.value !== undefined) value[paramId] = normalized.value;
    } else {
      errors.push(normalized.error);
    }
  }

  if (errors.length > 0) return { ok: false, value, errors };
  return { ok: true, value, errors: [] };
}

function normalizeOneParam(
  paramId: string,
  definition: RpaDslParamDefinition,
  raw: RuntimeParamValue | undefined,
):
  | { ok: true; value: RuntimeParamValue | undefined }
  | { ok: false; error: RuntimeParamValidationError } {
  if (raw === undefined || raw === null || raw === '') {
    if (definition.required === true) {
      return {
        ok: false,
        error: {
          paramId,
          code: 'PARAM_REQUIRED',
          message: `${definition.label ?? paramId} is required.`,
        },
      };
    }
    return { ok: true, value: raw === null ? null : undefined };
  }

  if (definition.type === 'string' || definition.type === 'secret' || definition.type === 'date') {
    if (typeof raw !== 'string') return invalidType(paramId, definition);
    return { ok: true, value: raw };
  }

  if (definition.type === 'number') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: raw };
    if (typeof raw === 'string' && raw.trim().length > 0 && Number.isFinite(Number(raw))) {
      return { ok: true, value: Number(raw) };
    }
    return invalidType(paramId, definition);
  }

  if (definition.type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return invalidType(paramId, definition);
  }

  if (definition.type === 'select') {
    if (typeof raw !== 'string') return invalidType(paramId, definition);
    const allowed = new Set((definition.options ?? []).map((option) => option.value));
    if (!allowed.has(raw)) {
      return {
        ok: false,
        error: {
          paramId,
          code: 'PARAM_OPTION_INVALID',
          message: `${definition.label ?? paramId} must be one of the configured options.`,
        },
      };
    }
    return { ok: true, value: raw };
  }

  return {
    ok: false,
    error: {
      paramId,
      code: 'PARAM_UNSUPPORTED',
      message: `${definition.label ?? paramId} uses an unsupported parameter type.`,
    },
  };
}

function invalidType(paramId: string, definition: RpaDslParamDefinition) {
  return {
    ok: false as const,
    error: {
      paramId,
      code: 'PARAM_TYPE_INVALID' as const,
      message: `${definition.label ?? paramId} must be a ${definition.type} value.`,
    },
  };
}

function mapParamTypeToFieldType(param: RpaDslParamDefinition): RpaRuntimeParamField['type'] {
  if (param.type === 'number') return 'number';
  if (param.type === 'date') return 'date';
  if (param.type === 'boolean') return 'checkbox';
  if (param.type === 'select') return 'select';
  if (param.type === 'secret') return 'password';
  return 'text';
}

import type { RpaRedactionOptions } from './rpa-observability-types.js';

const sensitiveKeyPattern = /^(password|passwd|secret|token|cookie|storage_state|storageState)$/i;
const identityPattern = /\b(?:\d{17}[\dXx]|\d{15})\b/g;
const phonePattern = /\b1[3-9]\d{9}\b/g;
const MIN_MASKED_PARAM_TEXT_LENGTH = 4;

export function redactRpaText(text: string, options: RpaRedactionOptions): string {
  let redacted = text;
  if (options.storageRoot.length > 0) {
    redacted = redacted.split(options.storageRoot).join('[rpa-storage]');
  }

  for (const [paramId, value] of maskedParamValues(options)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(value), 'g'), `[masked-param:${paramId}]`);
  }

  return redacted
    .replace(identityPattern, '[redacted-id]')
    .replace(phonePattern, '[redacted-phone]');
}

export function redactRpaValue(value: unknown, options: RpaRedactionOptions): unknown {
  return redactValue(value, options, new WeakSet<object>(), undefined);
}

function redactValue(
  value: unknown,
  options: RpaRedactionOptions,
  seen: WeakSet<object>,
  key: string | undefined,
): unknown {
  if (key && options.maskedParamIds.includes(key)) {
    return `[masked-param:${key}]`;
  }
  if (key && sensitiveKeyPattern.test(key)) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    return redactRpaText(value, options);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return '[redacted-circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options, seen, undefined));
  }

  const output: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    output[nestedKey] = redactValue(nestedValue, options, seen, nestedKey);
  }
  return output;
}

function maskedParamValues(options: RpaRedactionOptions): Array<[string, string]> {
  return options.maskedParamIds
    .flatMap((paramId): Array<[string, string]> => {
      const value = options.params[paramId];
      if (value === null || value === undefined) {
        return [];
      }
      const text = String(value);
      return text.length >= MIN_MASKED_PARAM_TEXT_LENGTH ? [[paramId, text]] : [];
    })
    .sort((left, right) => right[1].length - left[1].length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

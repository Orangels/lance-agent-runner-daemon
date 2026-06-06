const absolutePosixPathPattern = /(?:^|[\s"'([{:=])\/[^\s"'()[\]{}<>]+/g;
const sensitiveAssignmentPattern =
  /\b(cookie|token|api[_-]?key|password|passwd|secret|private[_-]?key|privateKey|storage_state|storageState)\b\s*[:=]\s*\S+/gi;
const sensitiveKeyPattern =
  /^(authorization|cookie|token|api[_-]?key|apiKey|password|passwd|secret|private[_-]?key|privateKey|storage_state|storageState)$/i;

export function sanitizeLogText(text: string): string {
  return text
    .replace(/\bCLAUDE_CONFIG_DIR\s*=\s*\S+/gi, '[redacted]')
    .replace(/\b(authorization)\s*:\s*Bearer\s+\S+/gi, '$1: [redacted]')
    .replace(sensitiveAssignmentPattern, '$1=[redacted]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(absolutePosixPathPattern, (match) => {
      const prefix = match.startsWith('/') ? '' : match[0]!;
      return `${prefix}[redacted-path]`;
    });
}

export function sanitizeReviewJsonText(text: string): string {
  try {
    return JSON.stringify(sanitizeReviewValue(JSON.parse(text)));
  } catch {
    return sanitizeLogText(text);
  }
}

export function sanitizeReviewValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return sanitizeLogText(value);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return '[redacted-circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReviewValue(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = sensitiveKeyPattern.test(key) ? '[redacted]' : sanitizeReviewValue(nestedValue, seen);
  }
  return output;
}

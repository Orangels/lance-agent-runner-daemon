const absolutePosixPathPattern = /(?:^|[\s"'([{:=])\/[^\s"'()[\]{}<>]+/g;

export function sanitizeLogText(text: string): string {
  return text
    .replace(/\bCLAUDE_CONFIG_DIR\s*=\s*\S+/gi, '[redacted]')
    .replace(/\b(authorization)\s*:\s*Bearer\s+\S+/gi, '$1: [redacted]')
    .replace(/\b(cookie|token|api[_-]?key)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(absolutePosixPathPattern, (match) => {
      const prefix = match.startsWith('/') ? '' : match[0]!;
      return `${prefix}[redacted-path]`;
    });
}

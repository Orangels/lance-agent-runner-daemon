const sensitiveSegmentPattern =
  /(^|[._-])(storage_state|cookies?|tokens?|secrets?|credentials?|passwords?|ca_|usbkey)([._-]|$)/i;
const sensitiveExtensionPattern = /\.(env|key|pem|pfx|p12|crt|cer)$/i;

export function isSensitiveArtifactPath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase().replaceAll('\\', '/');
  if (sensitiveExtensionPattern.test(normalized)) return true;
  return normalized.split('/').some((part) => sensitiveSegmentPattern.test(part));
}

export function isKnownToolStateArtifactPath(
  relativePath: string,
  options: { outputPrefix?: boolean } = {},
): boolean {
  const normalized = relativePath.toLowerCase().replaceAll('\\', '/');
  const prefixes = options.outputPrefix
    ? ['output/.omc/', 'output/.config/', 'output/.claude/', 'output/.cache/', 'output/__pycache__/']
    : ['.omc/', '.config/', '.claude/', '.cache/', '__pycache__/'];
  return prefixes.some((prefix) => normalized.startsWith(prefix)) || normalized.endsWith('.pyc') || normalized.endsWith('.pyo');
}

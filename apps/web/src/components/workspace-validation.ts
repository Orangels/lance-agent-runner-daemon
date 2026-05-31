export function isSafeWorkspaceSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[\\/]/.test(value) && !value.includes('\0');
}

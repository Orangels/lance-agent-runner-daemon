import path from 'node:path';
import { daemonError } from './errors.js';

export function assertSafePathSegment(segment: string, field = 'path segment'): string {
  if (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw daemonError('INVALID_PATH_SEGMENT', `Invalid ${field}`, 400, { value: segment });
  }

  return segment;
}

export function assertWorkspaceRelativePath(relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(relativePath)
  ) {
    throw pathNotAllowed(relativePath);
  }

  const segments = relativePath.split(/[\\/]/);
  if (
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    segments[0] === '.claude-runner-skills'
  ) {
    throw pathNotAllowed(relativePath);
  }

  return segments.join('/');
}

export function isPathInsideRoot(root: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidatePath);

  if (resolvedCandidate === resolvedRoot) {
    return true;
  }

  const rootWithSeparator = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  return resolvedCandidate.startsWith(rootWithSeparator);
}

export function resolveUnderRoot(root: string, candidatePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(resolvedRoot, candidatePath);

  if (!isPathInsideRoot(resolvedRoot, resolvedCandidate)) {
    throw pathNotAllowed(candidatePath);
  }

  return resolvedCandidate;
}

function pathNotAllowed(value: string): never {
  throw daemonError('PATH_NOT_ALLOWED', 'Path is not allowed', 400, { value });
}

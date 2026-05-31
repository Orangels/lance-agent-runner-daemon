import { describe, expect, it } from 'vitest';
import { DaemonError } from '../errors.js';
import {
  assertSafePathSegment,
  assertWorkspaceRelativePath,
  isPathInsideRoot,
  resolveUnderRoot,
} from '../path-safety.js';

describe('safe path segment validation', () => {
  it('accepts safe identity path segments', () => {
    expect(assertSafePathSegment('lqbot')).toBe('lqbot');
    expect(assertSafePathSegment('user_1')).toBe('user_1');
    expect(assertSafePathSegment('project-123')).toBe('project-123');
  });

  it.each(['', '.', '..', 'user/1', 'user\\1', 'user\0one'])(
    'rejects unsafe identity segment %s',
    (segment) => {
      expect(() => assertSafePathSegment(segment)).toThrow(DaemonError);
      try {
        assertSafePathSegment(segment);
        throw new Error('expected segment validation failure');
      } catch (error) {
        expect((error as DaemonError).code).toBe('INVALID_PATH_SEGMENT');
      }
    },
  );
});

describe('workspace-relative path validation', () => {
  it('accepts safe workspace-relative paths', () => {
    expect(assertWorkspaceRelativePath('input/source.docx')).toBe('input/source.docx');
    expect(assertWorkspaceRelativePath('work/nested/file.txt')).toBe('work/nested/file.txt');
  });

  it.each([
    '/tmp/source.docx',
    '\\tmp\\source.docx',
    'C:\\tmp\\source.docx',
    '../source.docx',
    'input/../source.docx',
    'input//source.docx',
    'input/source\0.docx',
    '.claude-runner-skills/report-writer/SKILL.md',
  ])('rejects unsafe workspace-relative path %s', (relativePath) => {
    expect(() => assertWorkspaceRelativePath(relativePath)).toThrow(DaemonError);
    try {
      assertWorkspaceRelativePath(relativePath);
      throw new Error('expected path validation failure');
    } catch (error) {
      expect((error as DaemonError).code).toBe('PATH_NOT_ALLOWED');
    }
  });
});

describe('root containment', () => {
  it('accepts paths under a root', () => {
    expect(isPathInsideRoot('/tmp/allowed-root', '/tmp/allowed-root/file.txt')).toBe(true);
    expect(resolveUnderRoot('/tmp/allowed-root', 'nested/file.txt')).toBe(
      '/tmp/allowed-root/nested/file.txt',
    );
  });

  it('accepts the root path itself', () => {
    expect(isPathInsideRoot('/tmp/allowed-root', '/tmp/allowed-root')).toBe(true);
  });

  it('rejects sibling-prefix escapes', () => {
    expect(isPathInsideRoot('/tmp/allowed-root', '/tmp/allowed-root-evil/file.txt')).toBe(false);
  });

  it('rejects parent traversal when resolving under a root', () => {
    expect(() => resolveUnderRoot('/tmp/allowed-root', '../escape.txt')).toThrow(DaemonError);
  });
});

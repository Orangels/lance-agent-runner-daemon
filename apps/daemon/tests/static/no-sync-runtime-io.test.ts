import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const runtimeGlobs = ['src/core/**/*.ts', 'src/http/**/*.ts', 'src/index.ts'];

const allowedFiles = new Set([
  // HTTP download routes and artifact scanner may create read streams without blocking.
  'src/http/artifacts-routes.ts',
  'src/http/logs-routes.ts',
  'src/core/artifact-scanner.ts',
]);

const allowedFsImports = new Map<string, Set<string>>([
  ['src/http/artifacts-routes.ts', new Set(['createReadStream'])],
  ['src/http/logs-routes.ts', new Set(['createReadStream'])],
  ['src/core/artifact-scanner.ts', new Set(['createReadStream'])],
]);

describe('runtime filesystem I/O', () => {
  it('does not use synchronous filesystem APIs in daemon runtime paths', async () => {
    const files = await fg(runtimeGlobs, {
      cwd: daemonRoot,
      absolute: false,
    });
    const violations: string[] = [];

    for (const file of files.sort()) {
      const source = await readFile(path.resolve(daemonRoot, file), 'utf8');
      const syncCalls = source.match(/\b[A-Za-z0-9_]+Sync\b/g) ?? [];
      for (const call of syncCalls) {
        violations.push(`${file}: synchronous call ${call}`);
      }

      const fsImport = source.match(/import\s+\{([^}]+)\}\s+from ['"]node:fs['"]/);
      if (!fsImport) {
        continue;
      }
      const importedNames = fsImport[1]!
        .split(',')
        .map((item) => item.trim().split(/\s+as\s+/)[0]!.trim())
        .filter(Boolean);
      const allowed = allowedFsImports.get(file) ?? new Set<string>();
      for (const importedName of importedNames) {
        if (!allowedFiles.has(file) || !allowed.has(importedName)) {
          violations.push(`${file}: imports node:fs ${importedName}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

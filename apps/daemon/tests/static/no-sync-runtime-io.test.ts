import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const runtimeGlobs = ['src/core/**/*.ts', 'src/http/**/*.ts', 'src/db/postgres/**/*.ts', 'src/index.ts'];

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
  it('scans PostgreSQL runtime persistence files', async () => {
    expect(runtimeGlobs).toContain('src/db/postgres/**/*.ts');
  });

  it('detects synchronous filesystem APIs through alternate node:fs import forms', () => {
    const violations = collectRuntimeFileIoViolations(
      'src/db/postgres/repositories.ts',
      `
        import * as fs from 'node:fs';
        import fsDefault from 'node:fs';
        const fsRequire = require('node:fs');
        fs.mkdirSync('/tmp/a');
        fsDefault.readFileSync('/tmp/a');
        fsRequire.rmSync('/tmp/a');
      `,
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        'src/db/postgres/repositories.ts: imports node:fs namespace',
        'src/db/postgres/repositories.ts: imports node:fs default',
        'src/db/postgres/repositories.ts: requires node:fs',
        'src/db/postgres/repositories.ts: synchronous call mkdirSync',
        'src/db/postgres/repositories.ts: synchronous call readFileSync',
        'src/db/postgres/repositories.ts: synchronous call rmSync',
      ]),
    );
  });

  it('does not use synchronous filesystem APIs in daemon runtime paths', async () => {
    const files = await fg(runtimeGlobs, {
      cwd: daemonRoot,
      absolute: false,
    });
    const violations: string[] = [];

    for (const file of files.sort()) {
      const source = await readFile(path.resolve(daemonRoot, file), 'utf8');
      violations.push(...collectRuntimeFileIoViolations(file, source));
    }

    expect(violations).toEqual([]);
  });
});

function collectRuntimeFileIoViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  const syncCalls = source.match(/\b[A-Za-z0-9_]+Sync\b/g) ?? [];
  for (const call of syncCalls) {
    violations.push(`${file}: synchronous call ${call}`);
  }

  if (/import\s+\*\s+as\s+\w+\s+from\s+['"]node:fs['"]/.test(source)) {
    violations.push(`${file}: imports node:fs namespace`);
  }
  if (/import\s+\w+\s+from\s+['"]node:fs['"]/.test(source)) {
    violations.push(`${file}: imports node:fs default`);
  }
  if (/\brequire\s*\(\s*['"]node:fs['"]\s*\)/.test(source)) {
    violations.push(`${file}: requires node:fs`);
  }

  const fsImport = source.match(/import\s+\{([^}]+)\}\s+from ['"]node:fs['"]/);
  if (!fsImport) {
    return violations;
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
  return violations;
}

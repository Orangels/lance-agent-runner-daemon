import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(daemonRoot, '../..');

const scanGlobs = ['apps/daemon/src/**/*.ts', 'apps/daemon/tests/**/*.ts'];

const migrationAllowedFiles = new Set([
  'apps/daemon/tests/db/sqlite-source-fixtures.ts',
  'apps/daemon/tests/db/sqlite-to-postgres.test.ts',
  'apps/daemon/tests/db/verify-sqlite-to-postgres.test.ts',
]);

const removedRuntimeModuleNames = ['connection', 'schema', 'repositories', 'sqlite-persistence'];
const removedRuntimeModules = new Set(
  removedRuntimeModuleNames.map((moduleName) => `apps/daemon/src/db/${moduleName}.ts`),
);

const forbiddenRuntimeSymbols = ['create' + 'SqliteRunnerPersistence', 'open' + 'InMemoryDatabase'];

describe('runtime SQLite imports', () => {
  it('does not import removed SQLite runtime backend modules outside migration tooling', async () => {
    const files = await collectScannedFiles();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(path.resolve(repoRoot, file), 'utf8');
      violations.push(...collectImportViolations(file, source));
    }

    expect(violations).toEqual([]);
  });

  it('does not reference removed SQLite runtime fixture symbols', async () => {
    const files = (await collectScannedFiles()).filter((file) => file !== 'apps/daemon/tests/static/no-runtime-sqlite-imports.test.ts');
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(path.resolve(repoRoot, file), 'utf8');
      for (const symbol of forbiddenRuntimeSymbols) {
        if (source.includes(symbol)) {
          violations.push(`${file}: references ${symbol}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function collectScannedFiles(): Promise<string[]> {
  return (
    await fg(scanGlobs, {
      cwd: repoRoot,
      absolute: false,
    })
  ).sort();
}

function collectImportViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  for (const specifier of collectImportSpecifiers(source)) {
    if (specifier === 'better-sqlite3' && !isMigrationAllowed(file)) {
      violations.push(`${file}: imports better-sqlite3`);
      continue;
    }
    const resolved = resolveImportSpecifier(file, specifier);
    if (resolved && removedRuntimeModules.has(resolved)) {
      violations.push(`${file}: imports removed runtime SQLite module ${specifier}`);
      continue;
    }
    if (isRuntimeSqliteBackendSpecifier(specifier)) {
      violations.push(`${file}: imports removed runtime SQLite module ${specifier}`);
    }
  }
  return violations;
}

function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]!);
    }
  }
  return specifiers;
}

function resolveImportSpecifier(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.normalize(path.join(path.dirname(file), specifier));
  if (resolved.endsWith('.js')) {
    return `${resolved.slice(0, -'.js'.length)}.ts`;
  }
  return resolved;
}

function isRuntimeSqliteBackendSpecifier(specifier: string): boolean {
  const alternatives = removedRuntimeModuleNames.join('|');
  return new RegExp(`(?:^|/)src/db/(?:${alternatives})\\.js$`).test(specifier);
}

function isMigrationAllowed(file: string): boolean {
  return file.startsWith('apps/daemon/src/db/migration/') || migrationAllowedFiles.has(file);
}

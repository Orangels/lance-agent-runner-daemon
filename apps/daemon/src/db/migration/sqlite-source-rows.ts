import Database from 'better-sqlite3';
import type { MigrationTableSpec } from './migration-types.js';

export function readSqliteRows(
  sqlite: Database.Database,
  spec: MigrationTableSpec,
): Array<Record<string, unknown>> {
  if (!hasTable(sqlite, spec.table)) {
    return [];
  }
  const existingColumns = new Set(tableColumns(sqlite, spec.table));
  const selectList = spec.columns
    .map((column) => {
      if (existingColumns.has(column)) {
        return quoteIdentifier(column);
      }
      const fallback = spec.defaults?.[column];
      if (fallback === undefined) {
        throw new Error(`SQLite source table ${spec.table} is missing required column ${column}`);
      }
      return `${fallback} AS ${quoteIdentifier(column)}`;
    })
    .join(', ');
  return sqlite.prepare(`SELECT ${selectList} FROM ${quoteIdentifier(spec.table)}`).all() as Array<
    Record<string, unknown>
  >;
}

export function hasTable(sqlite: Database.Database, table: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

function tableColumns(sqlite: Database.Database, table: string): string[] {
  return sqlite
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

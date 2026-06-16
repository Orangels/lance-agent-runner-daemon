import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { createPostgresPool } from '../postgres/connection.js';
import { assertPostgresSchemaReady } from '../postgres/migrate.js';
import { migrationTableSpecs, type MigrationTableSpec } from './migration-types.js';

export interface VerifySqliteToPostgresInput {
  sqlitePath: string;
  databaseUrl: string;
  json?: boolean;
}

export interface VerificationMismatch {
  table: string;
  kind: 'count' | 'primary_key_set' | 'row_hash';
  message: string;
}

export interface VerifySqliteToPostgresResult {
  ok: boolean;
  counts: Record<string, { sqlite: number; postgres: number }>;
  mismatches: VerificationMismatch[];
}

export async function verifySqliteToPostgres(
  input: VerifySqliteToPostgresInput,
): Promise<VerifySqliteToPostgresResult> {
  if (!existsSync(input.sqlitePath)) {
    throw new Error(`SQLite source file does not exist: ${input.sqlitePath}`);
  }
  await assertPostgresSchemaReady(input.databaseUrl);
  const sqlite = new Database(input.sqlitePath, { readonly: true, fileMustExist: true });
  const pool = createPostgresPool({ databaseUrl: input.databaseUrl });
  const counts: VerifySqliteToPostgresResult['counts'] = {};
  const mismatches: VerificationMismatch[] = [];
  try {
    for (const spec of migrationTableSpecs) {
      const sqliteRows = readSqliteRows(sqlite, spec);
      const postgresRows = await readPostgresRows(pool, spec);
      counts[spec.table] = { sqlite: sqliteRows.length, postgres: postgresRows.length };
      if (sqliteRows.length !== postgresRows.length) {
        mismatches.push({
          table: spec.table,
          kind: 'count',
          message: `row count differs for ${spec.table}`,
        });
        continue;
      }

      const sqliteHashes = hashRows(spec, sqliteRows);
      const postgresHashes = hashRows(spec, postgresRows);
      const sqliteKeys = [...sqliteHashes.keys()].sort();
      const postgresKeys = [...postgresHashes.keys()].sort();
      if (JSON.stringify(sqliteKeys) !== JSON.stringify(postgresKeys)) {
        mismatches.push({
          table: spec.table,
          kind: 'primary_key_set',
          message: `primary key set differs for ${spec.table}`,
        });
        continue;
      }

      for (const key of sqliteKeys) {
        if (sqliteHashes.get(key) !== postgresHashes.get(key)) {
          mismatches.push({
            table: spec.table,
            kind: 'row_hash',
            message: `row hash differs for ${spec.table}:${key}`,
          });
        }
      }
    }
  } finally {
    sqlite.close();
    await pool.end();
  }

  return { ok: mismatches.length === 0, counts, mismatches };
}

function readSqliteRows(sqlite: Database.Database, spec: MigrationTableSpec): Array<Record<string, unknown>> {
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

async function readPostgresRows(
  pool: ReturnType<typeof createPostgresPool>,
  spec: MigrationTableSpec,
): Promise<Array<Record<string, unknown>>> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${spec.columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(spec.table)}`,
  );
  return result.rows;
}

function hashRows(spec: MigrationTableSpec, rows: Array<Record<string, unknown>>): Map<string, string> {
  return new Map(
    rows
      .map((row) => {
        const key = primaryKeyForRow(spec.table, row);
        const normalized = spec.columns.map((column) => normalizeValue(row[column]));
        const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
        return [key, hash] as const;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function primaryKeyForRow(table: string, row: Record<string, unknown>): string {
  if (table === 'artifacts' || table === 'workspaces' || table === 'conversations' || table === 'runs') {
    return String(row.id);
  }
  if (table === 'run_messages' || table === 'run_feedback') {
    return String(row.id);
  }
  return String(row.run_id);
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.getTime();
  return value;
}

function hasTable(sqlite: Database.Database, table: string): boolean {
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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): VerifySqliteToPostgresInput {
  let sqlitePath: string | undefined;
  let databaseUrl: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sqlite') {
      sqlitePath = argv[++index];
    } else if (arg === '--database-url') {
      databaseUrl = argv[++index];
    } else if (arg === '--json') {
      json = true;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (!sqlitePath) {
    throw new Error('--sqlite <path> is required');
  }
  const resolvedDatabaseUrl = databaseUrl ?? env.CLAUDE_RUNNER_DATABASE_URL;
  if (!resolvedDatabaseUrl) {
    throw new Error('CLAUDE_RUNNER_DATABASE_URL or --database-url is required');
  }
  return { sqlitePath, databaseUrl: resolvedDatabaseUrl, json };
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2), process.env);
  const result = await verifySqliteToPostgres(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`SQLite-to-PostgreSQL verification ${result.ok ? 'passed' : 'failed'}`);
    for (const mismatch of result.mismatches) {
      console.log(`${mismatch.table}\t${mismatch.kind}\t${mismatch.message}`);
    }
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

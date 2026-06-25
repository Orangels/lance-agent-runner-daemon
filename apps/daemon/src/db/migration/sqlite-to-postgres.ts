import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { createPostgresPool } from '../postgres/connection.js';
import { assertPostgresSchemaReady } from '../postgres/migrate.js';
import { migrationTableSpecs, type MigrationTableSpec } from './migration-types.js';
import { hasTable, quoteIdentifier, readSqliteRows } from './sqlite-source-rows.js';

export interface SqliteToPostgresInput {
  sqlitePath: string;
  databaseUrl: string;
  dryRun?: boolean;
}

export interface SqliteToPostgresResult {
  dryRun: boolean;
  copied: Record<string, number>;
}

interface SourceFingerprint {
  sha256: string;
  size: number;
  mtimeMs: number;
}

export async function migrateSqliteToPostgres(
  input: SqliteToPostgresInput,
): Promise<SqliteToPostgresResult> {
  if (!existsSync(input.sqlitePath)) {
    throw new Error(`SQLite source file does not exist: ${input.sqlitePath}`);
  }
  assertNoActiveSqliteJournal(input.sqlitePath);
  const before = fingerprintFile(input.sqlitePath);

  await assertPostgresSchemaReady(input.databaseUrl);
  const sqlite = new Database(input.sqlitePath, { readonly: true, fileMustExist: true });
  const pool = createPostgresPool({ databaseUrl: input.databaseUrl });
  const copied: Record<string, number> = {};
  try {
    assertDaemonSchema(sqlite);
    await assertPostgresTargetEmpty(pool);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const spec of migrationTableSpecs) {
        const rows = readSqliteRows(sqlite, spec);
        copied[spec.table] = rows.length;
        await insertRows(client, spec, rows);
      }

      if (input.dryRun) {
        await client.query('ROLLBACK');
      } else {
        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    sqlite.close();
    await pool.end();
  }

  const after = fingerprintFile(input.sqlitePath);
  if (
    before.sha256 !== after.sha256 ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error('SQLite source file changed during migration; PostgreSQL copy should be discarded');
  }

  return { dryRun: Boolean(input.dryRun), copied };
}

async function insertRows(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  spec: MigrationTableSpec,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  const columnSql = spec.columns.map(quoteIdentifier).join(', ');
  const valuesSql = spec.columns.map((_, index) => `$${index + 1}`).join(', ');
  const sql = `INSERT INTO ${quoteIdentifier(spec.table)} (${columnSql}) VALUES (${valuesSql})`;
  for (const row of rows) {
    await client.query(
      sql,
      spec.columns.map((column) => row[column] ?? null),
    );
  }
}

async function assertPostgresTargetEmpty(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  for (const spec of migrationTableSpecs) {
    const result = await pool.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(spec.table)}`,
    );
    if (Number(result.rows[0]?.count ?? 0) > 0) {
      throw new Error('PostgreSQL target is not empty; create a fresh database before migration');
    }
  }
}

function assertDaemonSchema(sqlite: Database.Database): void {
  if (!hasTable(sqlite, 'workspaces') || !hasTable(sqlite, 'runs')) {
    throw new Error('SQLite source does not look like a daemon runner database');
  }
}

function assertNoActiveSqliteJournal(sqlitePath: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (existsSync(`${sqlitePath}${suffix}`)) {
      throw new Error(
        `SQLite source has active journal/WAL sidecar ${suffix}; stop or recover the daemon before migration`,
      );
    }
  }
}

function fingerprintFile(filePath: string): SourceFingerprint {
  const data = readFileSync(filePath);
  const stats = statSync(filePath);
  return {
    sha256: createHash('sha256').update(data).digest('hex'),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): SqliteToPostgresInput {
  let sqlitePath: string | undefined;
  let databaseUrl: string | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sqlite') {
      sqlitePath = argv[++index];
    } else if (arg === '--database-url') {
      databaseUrl = argv[++index];
    } else if (arg === '--dry-run') {
      dryRun = true;
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

  return { sqlitePath, databaseUrl: resolvedDatabaseUrl, dryRun };
}

async function main(): Promise<void> {
  const result = await migrateSqliteToPostgres(parseArgs(process.argv.slice(2), process.env));
  console.log(JSON.stringify({ copied: result.copied, dryRun: result.dryRun }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

import { fileURLToPath, pathToFileURL } from 'node:url';
import { runner } from 'node-pg-migrate';

export const postgresMigrationsTable = 'pgmigrations';

const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));

export type PostgresMigrationCommand = 'up' | 'down' | 'status';

export interface RunPostgresMigrationsInput {
  databaseUrl: string;
  command?: PostgresMigrationCommand;
}

export async function runPostgresMigrations(input: RunPostgresMigrationsInput): Promise<void> {
  const command = input.command ?? 'up';
  if (command === 'status') {
    await assertPostgresSchemaReady(input.databaseUrl);
    return;
  }

  await runner({
    databaseUrl: input.databaseUrl,
    dir: migrationsDir,
    direction: command,
    migrationsTable: postgresMigrationsTable,
    singleTransaction: true,
    checkOrder: true,
    logger: silentMigrationLogger,
  });
}

export async function assertPostgresSchemaReady(databaseUrl: string): Promise<void> {
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [postgresMigrationsTable],
    );
    if (result.rowCount === 0) {
      throw new Error(
        'PostgreSQL schema is not ready: run pnpm db:migrate:pg before starting the daemon',
      );
    }

    const migrations = await pool.query<{ name: string }>(
      `SELECT name FROM ${postgresMigrationsTable} ORDER BY run_on DESC, id DESC LIMIT 1`,
    );
    if (migrations.rowCount === 0) {
      throw new Error(
        'PostgreSQL schema is not ready: run pnpm db:migrate:pg before starting the daemon',
      );
    }
  } finally {
    await pool.end();
  }
}

const silentMigrationLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function parseCommand(value: string | undefined): PostgresMigrationCommand {
  if (value === undefined) {
    return 'up';
  }
  if (value === 'up' || value === 'down' || value === 'status') {
    return value;
  }
  throw new Error(`Unsupported migration command: ${value}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.CLAUDE_RUNNER_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('CLAUDE_RUNNER_DATABASE_URL is required to run PostgreSQL migrations');
  }

  await runPostgresMigrations({
    databaseUrl,
    command: parseCommand(process.argv[2]),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

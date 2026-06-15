import pg from 'pg';

const int8Oid = 20;
pg.types.setTypeParser(int8Oid, (value) => Number(value));

export type PostgresPool = pg.Pool;
export type PostgresClient = pg.PoolClient | pg.Pool;

export interface CreatePostgresPoolInput {
  databaseUrl: string;
  poolMax?: number;
}

export function createPostgresPool(input: CreatePostgresPoolInput): PostgresPool {
  return new pg.Pool({
    connectionString: input.databaseUrl,
    max: input.poolMax ?? 10,
  });
}

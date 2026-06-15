# PostgreSQL Persistence Migration Runbook

This runbook migrates an existing daemon SQLite database into PostgreSQL. The merged daemon runtime supports PostgreSQL only; SQLite is a migration source and historical backup.

## Steps

1. Stop the daemon cleanly.
2. Back up `.claude-runner/data/runner.sqlite` and sibling `.claude-runner/data/runner.sqlite-wal` or `.claude-runner/data/runner.sqlite-shm` files if they exist.
3. Create the PostgreSQL database.
4. Run schema migrations:

```bash
CLAUDE_RUNNER_DATABASE_URL=postgres://user:pass@localhost:5432/lance_agent_daemon \
  pnpm db:migrate:pg
```

5. Copy SQLite data into the empty PostgreSQL database:

```bash
CLAUDE_RUNNER_DATABASE_URL=postgres://user:pass@localhost:5432/lance_agent_daemon \
  pnpm db:migrate:sqlite-to-pg -- \
  --sqlite .claude-runner/data/runner.sqlite
```

6. Verify the copy:

```bash
CLAUDE_RUNNER_DATABASE_URL=postgres://user:pass@localhost:5432/lance_agent_daemon \
  pnpm db:verify:sqlite-to-pg -- \
  --sqlite .claude-runner/data/runner.sqlite
```

7. Start the daemon with `server.persistence.databaseUrl` configured as `env:CLAUDE_RUNNER_DATABASE_URL`.
8. Run smoke tests for workspace creation, upload/prepare, generate/revise, poll or SSE, cancel, artifacts, logs, restart interruption, and idempotency replay.
9. Before this branch is merged, rollback means continuing to run `main` with the preserved SQLite file. After merge and PostgreSQL-only writes, rollback is a PostgreSQL restore operation; this tool does not copy PG-only post-cutover writes back into SQLite.

## Safety Notes

The SQLite migration source is opened read-only and must remain unchanged. If the migration reports an active journal/WAL sidecar or cannot open the SQLite source safely, stop or recover SQLite outside this daemon tool, then rerun against the unchanged source file.

The migration tool refuses to copy into a non-empty PostgreSQL target. Create a fresh empty database or reset it outside this tool before retrying.

The initial migration copies the SQLite source in a single PostgreSQL transaction. For very large historical databases, plan and test a dedicated chunked migration before cutover instead of assuming this tool streams in bounded batches.

Do not put database URLs in tracked config. Use `env:CLAUDE_RUNNER_DATABASE_URL`.

## Test Coverage Policy

PostgreSQL-specific schema, repository, migration, and API-flow tests require `CLAUDE_RUNNER_TEST_PG_URL`. Local runs without that variable skip PG-gated tests for convenience. CI must provide `CLAUDE_RUNNER_TEST_PG_URL`; otherwise those tests fail fast so a green CI run cannot rely only on SQLite compatibility fixtures.

## Runtime I/O Note

After the PostgreSQL runtime migration, daemon database operations and runtime filesystem operations are asynchronous. Migration tools may still use synchronous SQLite or file helpers because they are offline operator commands, not request-serving daemon paths.

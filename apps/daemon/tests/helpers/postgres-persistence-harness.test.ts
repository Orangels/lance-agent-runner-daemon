import { afterEach, describe, expect, it } from 'vitest';
import { createPostgresFilePersistenceHarness } from './postgres-persistence-harness.js';
import { createPostgresTestPool, requirePostgresTestUrl } from './postgres.js';

const postgresDescribe = requirePostgresTestUrl() === null ? describe.skip : describe;

let harness: Awaited<ReturnType<typeof createPostgresFilePersistenceHarness>> | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

postgresDescribe('postgres file persistence harness', () => {
  it('resets test data without dropping the migrated schema', async () => {
    harness = await createPostgresFilePersistenceHarness();
    expect(harness).not.toBeNull();
    const persistence = harness!.persistence;

    await persistence.upsertWorkspace({
      id: 'ws_before_reset',
      clientId: 'lqbot',
      profileId: 'report-docx',
      originId: 'lqbot',
      userId: 'user_1',
      projectId: 'project_1',
      now: 1000,
    });
    await expect(
      persistence.getWorkspaceForClient({
        workspaceId: 'ws_before_reset',
        clientId: 'lqbot',
      }),
    ).resolves.toMatchObject({ id: 'ws_before_reset' });

    await harness!.resetData();

    await expect(
      persistence.getWorkspaceForClient({
        workspaceId: 'ws_before_reset',
        clientId: 'lqbot',
      }),
    ).resolves.toBeNull();

    await expect(
      persistence.upsertWorkspace({
        id: 'ws_after_reset',
        clientId: 'lqbot',
        profileId: 'report-docx',
        originId: 'lqbot',
        userId: 'user_2',
        projectId: 'project_1',
        now: 2000,
      }),
    ).resolves.toMatchObject({ id: 'ws_after_reset' });

    const pool = createPostgresTestPool(harness!.databaseUrl);
    try {
      const migrations = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM pgmigrations');
      expect(Number(migrations.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});

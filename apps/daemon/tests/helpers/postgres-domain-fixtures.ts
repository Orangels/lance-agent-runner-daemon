import type { RunnerPersistence } from '../../src/db/types.js';

export async function seedWorkspace(
  persistence: RunnerPersistence,
  input: {
    id: string;
    clientId?: string;
    profileId?: string;
    originId?: string;
    userId?: string;
    projectId?: string;
    status?: string;
    metadata?: unknown;
    now?: number;
  },
): Promise<Awaited<ReturnType<RunnerPersistence['upsertWorkspace']>>> {
  return persistence.upsertWorkspace({
    id: input.id,
    clientId: input.clientId ?? 'lqbot',
    profileId: input.profileId ?? 'report-docx',
    originId: input.originId ?? 'origin',
    userId: input.userId ?? 'user',
    projectId: input.projectId ?? 'project',
    status: input.status ?? 'active',
    metadata: input.metadata ?? {},
    now: input.now ?? 1,
  });
}

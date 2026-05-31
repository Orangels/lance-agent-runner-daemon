export interface QueueCandidate {
  runId: string;
  profileId: string;
  workspaceId: string;
  status: 'queued' | 'starting' | 'running' | 'finishing' | 'terminal';
  sequence: number;
}

export interface QueueLimits {
  globalConcurrency: number;
  profileConcurrencyById: Map<string, number>;
}

const capacityConsumingStatuses = new Set<QueueCandidate['status']>([
  'starting',
  'running',
  'finishing',
]);

export function countQueued(candidates: readonly QueueCandidate[]): number {
  return candidates.filter((candidate) => candidate.status === 'queued').length;
}

export function countRunning(candidates: readonly QueueCandidate[]): number {
  return candidates.filter((candidate) => consumesCapacity(candidate)).length;
}

export function canStartCandidate(
  candidate: QueueCandidate,
  candidates: readonly QueueCandidate[],
  limits: QueueLimits,
): boolean {
  if (candidate.status !== 'queued') {
    return false;
  }

  if (countRunning(candidates) >= limits.globalConcurrency) {
    return false;
  }

  const profileLimit = limits.profileConcurrencyById.get(candidate.profileId);
  if (
    profileLimit !== undefined &&
    candidates.filter(
      (item) => item.profileId === candidate.profileId && consumesCapacity(item),
    ).length >= profileLimit
  ) {
    return false;
  }

  return !candidates.some(
    (item) => item.workspaceId === candidate.workspaceId && consumesCapacity(item),
  );
}

export function selectDispatchableCandidates(
  candidates: readonly QueueCandidate[],
  limits: QueueLimits,
): QueueCandidate[] {
  const selected: QueueCandidate[] = [];
  const candidatesWithSelected = [...candidates];
  const queued = [...candidates]
    .filter((candidate) => candidate.status === 'queued')
    .sort((left, right) => left.sequence - right.sequence);

  for (const candidate of queued) {
    if (!canStartCandidate(candidate, candidatesWithSelected, limits)) {
      continue;
    }

    selected.push(candidate);
    candidatesWithSelected.push({ ...candidate, status: 'starting' });
  }

  return selected;
}

function consumesCapacity(candidate: QueueCandidate): boolean {
  return capacityConsumingStatuses.has(candidate.status);
}

# Run Idempotency Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add generic idempotent run creation to `POST /api/runs` so business callers can safely retry the same dispatch after a crash without creating duplicate daemon runs.

**Architecture:** Store an optional `idempotency_key` and canonical `idempotency_fingerprint` on each run. `RunService.createRun` resolves defaults and validates access exactly as today, then checks for an existing run in the same `clientId/profileId/workspaceId/idempotencyKey` scope before creating a new queued run. Matching fingerprints replay the existing run response; different fingerprints return `409 IDEMPOTENCY_KEY_CONFLICT`.

**Tech Stack:** TypeScript, Express, Zod, better-sqlite3, Vitest, existing daemon SQLite migration helpers.

---

## File Structure

- Modify `apps/daemon/src/core/run-types.ts`
  - Add `IDEMPOTENCY_KEY_CONFLICT`.
  - Add optional `idempotencyKey` to `CreateRunRequest`.
- Modify `apps/daemon/src/core/run-service.ts`
  - Add optional `idempotentReplay` and non-queued replay status to `CreateRunResult`.
  - Build canonical fingerprint after profile defaults and artifact rule resolution.
  - Check existing idempotency key before queue capacity and insert.
  - Replay existing run without creating state/timers/messages.
  - Return 409 conflict on mismatched fingerprint.
  - Treat SQLite unique constraint collisions as a replay/conflict fallback, so correctness does not depend only on the current synchronous `createRun` implementation.
- Modify `apps/daemon/src/http/validation.ts`
  - Validate optional `idempotencyKey` as a non-empty short string.
- Modify `apps/daemon/src/db/schema.ts`
  - Add nullable `runs.idempotency_key`.
  - Add nullable `runs.idempotency_fingerprint`.
  - Add partial unique index on `client_id, profile_id, workspace_id, idempotency_key` where key is not null.
  - Add migration helpers for existing DB files.
- Modify `apps/daemon/src/db/repositories.ts`
  - Persist idempotency fields.
  - Map them onto `RunRecord`.
  - Add lookup helper for `client/profile/workspace/idempotencyKey`.
  - Return create messages for replay using existing run detail.
- Modify `apps/daemon/src/http/runs-routes.ts`
  - No route shape change expected beyond returning the service result.
- Modify `docs/api-reference.md`
  - Document `idempotencyKey`, replay response, and conflict error.
- Modify `apps/web/src/api/types.ts`
  - Keep the report demo client types aligned with the daemon API without changing UI behavior.
- Modify `apps/rpa-local-web/src/shared/daemon-types.ts`
  - Keep the RPA demo client types aligned with the daemon API without changing workflow behavior.
- Test files:
  - `apps/daemon/tests/http/validation.test.ts`
  - `apps/daemon/tests/db/schema.test.ts`
  - `apps/daemon/tests/db/repositories.test.ts`
  - `apps/daemon/tests/core/run-service.test.ts`
  - `apps/daemon/tests/http/runs-routes.test.ts`
  - `apps/daemon/tests/core/run-types.test.ts`

## Task 1: Request Type And Validation

**Files:**
- Modify: `apps/daemon/src/core/run-types.ts`
- Modify: `apps/daemon/src/http/validation.ts`
- Test: `apps/daemon/tests/http/validation.test.ts`
- Test: `apps/daemon/tests/core/run-types.test.ts`

- [ ] **Step 1: Write failing validation tests**

Add tests under `describe('run create request validation', ...)` in `apps/daemon/tests/http/validation.test.ts`:

```ts
it('accepts idempotencyKey on run create requests', () => {
  const parsed = createRunRequestSchema.parse({
    profileId: 'report-docx',
    workspaceId: 'ws_1',
    kind: 'generate',
    skillId: 'report-gen',
    prompt: 'Generate report.',
    idempotencyKey: 'origin:task_001:1',
  });

  expect(parsed.idempotencyKey).toBe('origin:task_001:1');
});

it('rejects empty idempotencyKey on run create requests', () => {
  expect(() =>
    createRunRequestSchema.parse({
      profileId: 'report-docx',
      workspaceId: 'ws_1',
      kind: 'generate',
      skillId: 'report-gen',
      prompt: 'Generate report.',
      idempotencyKey: '',
    }),
  ).toThrow();
});
```

Add a test in `apps/daemon/tests/core/run-types.test.ts`:

```ts
it('includes idempotency conflict in public error codes', () => {
  expect(daemonErrorCodes).toContain('IDEMPOTENCY_KEY_CONFLICT');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- tests/http/validation.test.ts tests/core/run-types.test.ts
```

Expected: validation test fails because `idempotencyKey` is rejected by strict schema, and run-types test fails because the error code is absent.

- [ ] **Step 3: Implement minimal type and validation changes**

In `apps/daemon/src/core/run-types.ts`, add:

```ts
'IDEMPOTENCY_KEY_CONFLICT',
```

to `daemonErrorCodes`, add:

```ts
idempotencyKey?: string;
```

to `CreateRunRequest`, and widen `CreateRunResult` in `apps/daemon/src/core/run-service.ts` to allow replay statuses:

```ts
export interface CreateRunResult {
  runId: string;
  status: RunStatus;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  idempotentReplay?: true;
}
```

In `apps/daemon/src/http/validation.ts`, add:

```ts
idempotencyKey: runShortStringSchema.optional(),
```

to `createRunRequestSchema`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- tests/http/validation.test.ts tests/core/run-types.test.ts
```

Expected: both files pass.

## Task 2: SQLite Schema And Repository Persistence

**Files:**
- Modify: `apps/daemon/src/db/schema.ts`
- Modify: `apps/daemon/src/db/repositories.ts`
- Test: `apps/daemon/tests/db/schema.test.ts`
- Test: `apps/daemon/tests/db/repositories.test.ts`

- [ ] **Step 1: Write failing schema tests**

In `apps/daemon/tests/db/schema.test.ts`, extend the run column test:

```ts
expect(listColumns(db, 'runs')).toEqual(
  expect.arrayContaining([
    'idempotency_key',
    'idempotency_fingerprint',
  ]),
);
```

Extend the index test:

```ts
expect(listNames(db, 'index')).toEqual(
  expect.arrayContaining([
    'idx_runs_idempotency_key',
  ]),
);
```

Add a migration test:

```ts
it('migrates existing runs tables to add idempotency columns and index', () => {
  const db = openInMemoryDatabase();
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      skill_id TEXT,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  applySchema(db);

  expect(listColumns(db, 'runs')).toEqual(
    expect.arrayContaining(['idempotency_key', 'idempotency_fingerprint']),
  );
  expect(listNames(db, 'index')).toContain('idx_runs_idempotency_key');
});
```

- [ ] **Step 2: Write failing repository tests**

In `apps/daemon/tests/db/repositories.test.ts`, import the new helper:

```ts
getRunByIdempotencyKey,
```

Add a test near other run repository tests:

```ts
it('stores and looks up runs by client-scoped idempotency key', () => {
  const db = openInMemoryDatabase();
  applySchema(db);
  const workspace = upsertWorkspace(db, {
    id: 'ws_1',
    clientId: 'lqbot',
    profileId: 'report-docx',
    originId: 'lqbot',
    userId: 'user_1',
    projectId: 'project_123',
    now: 1000,
  });

  createRunQueuedWithMessagesAndSnapshot(db, {
    runId: 'run_1',
    defaultConversationId: 'conv_1',
    userMessageId: 'msg_user',
    assistantMessageId: 'msg_assistant',
    workspaceId: workspace.id,
    profileId: 'report-docx',
    clientId: 'lqbot',
    kind: 'generate',
    skillId: 'report-writer',
    prompt: 'Generate.',
    artifactRuleIds: ['report-docx'],
    idempotencyKey: 'dispatch:1',
    idempotencyFingerprint: 'fingerprint-a',
    profileSnapshot: {},
    now: 1000,
  });

  expect(
    getRunByIdempotencyKey(db, {
      clientId: 'lqbot',
      profileId: 'report-docx',
      workspaceId: 'ws_1',
      idempotencyKey: 'dispatch:1',
    }),
  ).toEqual(expect.objectContaining({
    id: 'run_1',
    idempotencyKey: 'dispatch:1',
    idempotencyFingerprint: 'fingerprint-a',
  }));

  expect(
    getRunByIdempotencyKey(db, {
      clientId: 'other',
      profileId: 'report-docx',
      workspaceId: 'ws_1',
      idempotencyKey: 'dispatch:1',
    }),
  ).toBeNull();

  expect(
    getRunByIdempotencyKey(db, {
      clientId: 'lqbot',
      profileId: 'other-profile',
      workspaceId: 'ws_1',
      idempotencyKey: 'dispatch:1',
    }),
  ).toBeNull();

  expect(
    getRunByIdempotencyKey(db, {
      clientId: 'lqbot',
      profileId: 'report-docx',
      workspaceId: 'ws_2',
      idempotencyKey: 'dispatch:1',
    }),
  ).toBeNull();

  updateRunStatus(db, {
    runId: 'run_1',
    status: 'interrupted',
    now: 2000,
  });

  expect(
    getRunByIdempotencyKey(db, {
      clientId: 'lqbot',
      profileId: 'report-docx',
      workspaceId: 'ws_1',
      idempotencyKey: 'dispatch:1',
    }),
  ).toEqual(expect.objectContaining({
    id: 'run_1',
    status: 'interrupted',
  }));
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- tests/db/schema.test.ts tests/db/repositories.test.ts
```

Expected: schema tests fail because columns/index are absent; repository tests fail because helper and record fields are absent.

- [ ] **Step 4: Implement schema migration**

In `apps/daemon/src/db/schema.ts`, add columns to the `CREATE TABLE runs` block:

```sql
idempotency_key TEXT,
idempotency_fingerprint TEXT,
```

Add to `ensureRunColumns`:

```ts
ensureColumn(db, 'runs', 'idempotency_key', 'TEXT');
ensureColumn(db, 'runs', 'idempotency_fingerprint', 'TEXT');
```

Add a focused helper near the other schema helpers and call it from `applySchema` after `ensureRunColumns(db)`:

```ts
function ensureRunIdempotencyIndex(db: RunnerDatabase): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency_key
      ON runs(client_id, profile_id, workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
}
```

Do not make non-idempotent runs unique; the partial index must ignore `NULL` keys.

- [ ] **Step 5: Implement repository fields and lookup**

In `apps/daemon/src/db/repositories.ts`, add `idempotency_key` and `idempotency_fingerprint` to `RunRow`, map them to `RunRecord` as `idempotencyKey` and `idempotencyFingerprint`, add optional inputs to `insertRunQueued` and `createRunQueuedWithMessagesAndSnapshot`, and include both columns in the insert.

Add:

```ts
export function getRunByIdempotencyKey(
  db: RunnerDatabase,
  input: {
    clientId: string;
    profileId: string;
    workspaceId: string;
    idempotencyKey: string;
  },
): RunRecord | null {
  const row = db
    .prepare(
      `
      SELECT *
      FROM runs
      WHERE client_id = ?
        AND profile_id = ?
        AND workspace_id = ?
        AND idempotency_key = ?
      `,
    )
    .get(input.clientId, input.profileId, input.workspaceId, input.idempotencyKey) as
    | RunRow
    | undefined;

  return row ? mapRun(row) : null;
}
```

Add a small SQLite constraint detector for the run service to use after an attempted insert races with the unique index:

```ts
export function isSqliteUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}
```

When adding `idempotency_key` and `idempotency_fingerprint` to `insertRunQueued`, update all three parts of the handwritten insert together:

- the column list,
- the `VALUES (?, ... ?)` placeholder list,
- the `.run(...)` argument list.

The existing insert is positional, so a placeholder count mismatch will fail at runtime even if TypeScript compiles.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- tests/db/schema.test.ts tests/db/repositories.test.ts
```

Expected: both files pass.

## Task 3: Run Service Idempotent Replay And Conflict

**Files:**
- Modify: `apps/daemon/src/core/run-service.ts`
- Test: `apps/daemon/tests/core/run-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Add tests in `apps/daemon/tests/core/run-service.test.ts`:

```ts
it('replays an existing run for the same idempotency key and fingerprint', () => {
  const { config, workspace, service, runners, pendingTimers } = setup();

  const first = service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate the report.',
      artifactRuleIds: ['report-docx'],
      idempotencyKey: 'dispatch:1',
    },
  });
  const second = service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate the report.',
      artifactRuleIds: ['report-docx'],
      idempotencyKey: 'dispatch:1',
    },
  });

  expect(second).toEqual({
    ...first,
    idempotentReplay: true,
  });
  expect(runners).toHaveLength(0);
  expect(pendingTimers()).toHaveLength(1);
});

it('replays an interrupted run after daemon shutdown for the same idempotency key', async () => {
  const { config, workspace, service } = setup();

  const request = {
    profileId: 'report-docx',
    workspaceId: workspace.id,
    kind: 'generate' as const,
    skillId: 'report-writer',
    prompt: 'Generate the report.',
    artifactRuleIds: ['report-docx'],
    idempotencyKey: 'dispatch:1',
  };
  const first = service.createRun({
    client: config.clients[0]!,
    request,
  });

  await service.shutdownActive();
  const replay = service.createRun({
    client: config.clients[0]!,
    request,
  });

  expect(replay.runId).toBe(first.runId);
  expect(replay.status).toBe('interrupted');
  expect(replay.idempotentReplay).toBe(true);
});

it('rejects reuse of an idempotency key with different run parameters', () => {
  const { config, workspace, service } = setup();

  service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate the report.',
      artifactRuleIds: ['report-docx'],
      idempotencyKey: 'dispatch:1',
    },
  });

  expect(() =>
    service.createRun({
      client: config.clients[0]!,
      request: {
        profileId: 'report-docx',
        workspaceId: workspace.id,
        kind: 'generate',
        skillId: 'report-writer',
        prompt: 'Generate a different report.',
        artifactRuleIds: ['report-docx'],
        idempotencyKey: 'dispatch:1',
      },
    }),
  ).toThrow(expect.objectContaining({
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    status: 409,
  }));
});

it('creates a new run when idempotency key changes', () => {
  const { config, workspace, service } = setup();

  const first = service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate the report.',
      artifactRuleIds: ['report-docx'],
      idempotencyKey: 'dispatch:1',
    },
  });
  const second = service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate the report.',
      artifactRuleIds: ['report-docx'],
      idempotencyKey: 'dispatch:2',
    },
  });

  expect(second.runId).not.toBe(first.runId);
  expect(second.idempotentReplay).toBeUndefined();
});

it('does not apply idempotency when no idempotency key is provided', () => {
  const { config, workspace, service } = setup();

  const first = service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'revise',
      prompt: 'Revise.',
    },
  });
  const second = service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'revise',
      prompt: 'Revise.',
    },
  });

  expect(second.runId).not.toBe(first.runId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- tests/core/run-service.test.ts
```

Expected: tests fail because idempotency lookup, fingerprinting, and replay are not implemented.

- [ ] **Step 3: Implement canonical fingerprinting**

In `apps/daemon/src/core/run-service.ts`, import `createHash` from `node:crypto` and add helpers near `assertPromptModeRequestShape`:

```ts
function buildRunIdempotencyFingerprint(input: {
  profileId: string;
  workspaceId: string;
  kind: RunKind;
  skillId: string | null;
  promptMode: ActivePromptMode;
  currentPrompt: string;
  conversationId: string | null;
  collectionMode: CollectionMode;
  contextPolicy: ContextPolicy | undefined;
  businessContextHash: string | null;
  model: string;
  artifactRuleIds: string[];
}): string {
  return stableJsonHash({
    profileId: input.profileId,
    workspaceId: input.workspaceId,
    kind: input.kind,
    skillId: input.skillId,
    promptMode: input.promptMode,
    currentPromptHash: hashSensitiveText(input.currentPrompt),
    conversationId: input.conversationId,
    collectionMode: input.collectionMode,
    contextPolicy: input.contextPolicy ?? null,
    businessContextHash: input.businessContextHash,
    model: input.model,
    artifactRuleIds: input.artifactRuleIds,
  });
}

function hashSensitiveText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
```

When calling this helper, pass values after daemon resolution:

```ts
const idempotencyFingerprint = request.idempotencyKey
  ? buildRunIdempotencyFingerprint({
      profileId: profile.id,
      workspaceId: workspace.id,
      kind: request.kind,
      skillId: request.skillId ?? null,
      promptMode: activePromptMode,
      currentPrompt,
      conversationId: request.conversationId ?? null,
      collectionMode,
      contextPolicy: request.contextPolicy,
      businessContextHash,
      model: selectedModel,
      artifactRuleIds: selectedArtifactRuleIds,
    })
  : null;
```

This must use `selectedModel` and `selectedArtifactRuleIds`, not raw request fields, so explicit defaults and omitted defaults produce the same fingerprint.

- [ ] **Step 4: Implement replay path and unique-constraint fallback**

Move the existing `businessContextHash` and `persistBusinessContext` calculation above the queue capacity check. The idempotency fingerprint depends on `businessContextHash`, and replay must happen before `RUN_QUEUE_FULL` can be returned. Queue capacity should block only new run creation, not replay of an already-created run.

In `createRun`, after workspace validation, artifact rule resolution, selected model resolution, and `businessContextHash` calculation, compute fingerprint. If `request.idempotencyKey` exists, call `getRunByIdempotencyKey`. If found:

```ts
return replayIdempotentRun({
  client,
  existing,
  expectedFingerprint: idempotencyFingerprint,
  requestConversationId: request.conversationId,
});
```

Add a helper in `createRunService` that performs the fingerprint comparison and durable detail lookup:

```ts
function replayIdempotentRun(replayInput: {
  client: ClientConfig;
  existing: RunRecord;
  expectedFingerprint: string | null;
  requestConversationId?: string;
}): CreateRunResult {
  if (!replayInput.expectedFingerprint || replayInput.existing.idempotencyFingerprint !== replayInput.expectedFingerprint) {
    throw daemonError(
      'IDEMPOTENCY_KEY_CONFLICT',
      'idempotency key was already used with different run parameters',
      409,
    );
  }
  const detail = getRunDetail(input.db, {
    runId: replayInput.existing.id,
    clientId: replayInput.client.id,
    isAdmin: replayInput.client.isAdmin,
  });
  if (!detail) {
    throw notFound('Run not found');
  }
  return {
    runId: replayInput.existing.id,
    status: replayInput.existing.status,
    conversationId: detail.messages[0]?.conversationId ?? replayInput.requestConversationId ?? '',
    userMessageId: detail.messages.find((message) => message.role === 'user')?.id ?? '',
    assistantMessageId: detail.messages.find((message) => message.role === 'assistant')?.id ?? '',
    idempotentReplay: true,
  };
}
```

Keep the helper inside `createRunService` and use `input.db` from that closure, or pass `db` explicitly; do not reference an out-of-scope variable from a top-level helper.

Pass `idempotencyKey` and `idempotencyFingerprint` into `createRunQueuedWithMessagesAndSnapshot` for new runs.

Wrap the insert call with a fallback for `isSqliteUniqueConstraintError(error)`:

```ts
try {
  created = createRunQueuedWithMessagesAndSnapshot(input.db, { ... });
} catch (error) {
  if (request.idempotencyKey && isSqliteUniqueConstraintError(error)) {
    const existing = getRunByIdempotencyKey(input.db, {
      clientId: client.id,
      profileId: profile.id,
      workspaceId: workspace.id,
      idempotencyKey: request.idempotencyKey,
    });
    if (existing) {
      return replayIdempotentRun({
        client,
        existing,
        expectedFingerprint: idempotencyFingerprint,
        requestConversationId: request.conversationId,
      });
    }
  }
  throw error;
}
```

Current `createRun` is synchronous and better-sqlite3 writes are synchronous, so same-process requests are already serialized. The unique index and fallback are still required as defense-in-depth if future code introduces an async gap before insert.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- tests/core/run-service.test.ts
```

Expected: run-service tests pass.

## Task 4: HTTP Contract Tests

**Files:**
- Modify: `apps/daemon/tests/http/runs-routes.test.ts`

- [ ] **Step 1: Write failing HTTP tests**

Add tests in `apps/daemon/tests/http/runs-routes.test.ts`:

```ts
it('replays POST /api/runs with the same idempotency key', async () => {
  await withApp(async ({ baseUrl, workspaceId }) => {
    const body = {
      profileId: 'report-docx',
      workspaceId,
      kind: 'generate',
      skillId: 'report-writer',
      prompt: 'Generate.',
      artifactRuleIds: ['report-docx'],
      idempotencyKey: 'dispatch:1',
    };

    const first = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const firstPayload = await first.json();
    const second = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(second.status).toBe(202);
    const secondPayload = await second.json();
    expect(secondPayload.runId).toBe(firstPayload.runId);
    expect(secondPayload.conversationId).toBe(firstPayload.conversationId);
    expect(secondPayload.userMessageId).toBe(firstPayload.userMessageId);
    expect(secondPayload.assistantMessageId).toBe(firstPayload.assistantMessageId);
    expect(secondPayload.idempotentReplay).toBe(true);
    expect(['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted']).toContain(secondPayload.status);
  });
});

it('returns 409 when idempotency key is reused with different parameters', async () => {
  await withApp(async ({ baseUrl, workspaceId }) => {
    const baseBody = {
      profileId: 'report-docx',
      workspaceId,
      kind: 'generate',
      skillId: 'report-writer',
      artifactRuleIds: ['report-docx'],
      idempotencyKey: 'dispatch:1',
    };

    await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody, prompt: 'Generate.' }),
    });
    const conflict = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody, prompt: 'Generate differently.' }),
    });

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: {
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message: 'idempotency key was already used with different run parameters',
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- tests/http/runs-routes.test.ts
```

Expected: tests fail before service implementation or pass after Task 3; if they pass immediately after Task 3, record that the HTTP layer already delegates correctly.

- [ ] **Step 3: Adjust route only if needed**

If response status or payload is wrong, update `apps/daemon/src/http/runs-routes.ts` so `router.post('/')` continues returning `202` with `runService.createRun(...)` for both first create and replay. Do not add route-specific idempotency logic.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- tests/http/runs-routes.test.ts
```

Expected: route tests pass.

## Task 5: Demo Web Client Type Alignment

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/rpa-local-web/src/shared/daemon-types.ts`
- Test: `pnpm typecheck:web`
- Test: `pnpm typecheck:rpa-local-web`

- [ ] **Step 1: Update demo client daemon types**

In both files, add the optional request field:

```ts
idempotencyKey?: string;
```

to `CreateRunRequest`.

In `apps/rpa-local-web/src/shared/daemon-types.ts`, first add the missing status union:

```ts
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
```

In `apps/web/src/api/types.ts`, add:

```ts
| 'IDEMPOTENCY_KEY_CONFLICT'
```

to `DaemonErrorCode`.

In both files, update `CreateRunResponse`:

```ts
export interface CreateRunResponse {
  runId: string;
  status: RunStatus;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  idempotentReplay?: true;
}
```

Do not update either UI to send `idempotencyKey`; the demos must keep current behavior unless a caller explicitly adds the field later.

- [ ] **Step 2: Run web typechecks**

Run:

```bash
pnpm typecheck:web
pnpm typecheck:rpa-local-web
```

Expected: both typechecks pass.

## Task 6: API Documentation

**Files:**
- Modify: `docs/api-reference.md`
- Test: `git diff --check -- docs/api-reference.md`

- [ ] **Step 1: Update docs**

In `docs/api-reference.md`:

- Add `IDEMPOTENCY_KEY_CONFLICT` to the error code list.
- Add `idempotencyKey` to `POST /api/runs` request example and field table.
- Document replay response:

```json
{
  "runId": "run_xxx",
  "status": "running",
  "conversationId": "conv_xxx",
  "userMessageId": "msg_user_xxx",
  "assistantMessageId": "msg_assistant_xxx",
  "idempotentReplay": true
}
```

- Add common error:

```markdown
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | 同一个 `idempotencyKey` 已被同 client/profile/workspace 下不同 run 参数使用。 |
```

- State that `idempotencyKey` is a generic daemon dispatch key, not a business task id, and must change for user retry/new generation attempts.
- State that `idempotencyKey` is stored in plaintext and must not contain API keys, credentials, personal data, full prompts, or other sensitive payload.

- [ ] **Step 2: Run docs check**

Run:

```bash
git diff --check -- docs/api-reference.md
```

Expected: no output.

## Task 7: Full Targeted Verification

**Files:**
- No source edits.

- [ ] **Step 1: Run focused daemon tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- \
  tests/http/validation.test.ts \
  tests/core/run-types.test.ts \
  tests/db/schema.test.ts \
  tests/db/repositories.test.ts \
  tests/core/run-service.test.ts \
  tests/http/runs-routes.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run daemon and demo-web typechecks**

Run:

```bash
pnpm typecheck:daemon
pnpm typecheck:web
pnpm typecheck:rpa-local-web
```

Expected: all TypeScript checks pass.

- [ ] **Step 3: Run daemon build**

Run:

```bash
pnpm build:daemon
```

Expected: build passes.

- [ ] **Step 4: Check git diff**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: no whitespace errors. `git status` may still show the user's existing `.claude-runner/config.local.json` modification; do not stage or revert it.

## Self-Review

- Spec coverage: The plan covers request validation, error code, schema migration, repository persistence, service replay/conflict behavior, interrupted replay after shutdown, HTTP behavior, demo web type alignment, documentation, and verification.
- CC review coverage: M1 is handled by field-level HTTP replay assertions with flexible status; M2 is handled by the interrupted replay service test; M3 is fixed by locating `CreateRunResult` under `run-service.ts`. S1 is handled by the unique index plus SQLite unique-constraint replay fallback and a written concurrency-safety note. S2 is handled by resolved `selectedModel`, `selectedArtifactRuleIds`, and `currentPrompt` fingerprint inputs. S3 is handled by `ensureRunIdempotencyIndex`. S4 is handled by client/profile/workspace lookup isolation plus interrupted lookup. S5 is handled by the plaintext key warning in API docs. The second review's RPA demo `RunStatus` gap is handled in Task 5, and the queue-capacity ordering risk is handled in Task 3 Step 4.
- Placeholder scan: No task uses TBD/TODO wording. Each task has concrete files, commands, and expected behavior.
- Type consistency: Public request field is `idempotencyKey`; DB columns are `idempotency_key` and `idempotency_fingerprint`; record fields are `idempotencyKey` and `idempotencyFingerprint`; replay response field is `idempotentReplay`.

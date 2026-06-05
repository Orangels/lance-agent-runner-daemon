# Slice 1a Daemon Business Context And Snapshot Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the generic daemon capabilities required by RPA MVP workflows: legacy compatibility, `business-context`, `revise + skillId`, reusable `conversationId`, `collectionMode` permission caps, and minimal prompt/skill/context snapshot persistence.

**Architecture:** Keep daemon business-agnostic. RPA Web sends user-visible `currentPrompt` and opaque `businessContext`; daemon validates the request, checks collection permissions before queue insertion, persists user-visible conversation messages, injects allowed skill instructions and staged side-file paths, composes the final prompt, and records snapshots according to `collectionMode`. `daemon-composed` transcript building is explicitly deferred to Slice 1b because it requires `conversation_seq` and stable cross-run message ordering.

**Tech Stack:** TypeScript ESM, Express validation with Zod, SQLite repositories, Vitest, existing daemon run service, prompt composer, skill registry, and skill staging.

---

## Scope Boundary

This Slice 1a implements:

- `promptMode = legacy | business-context`
- `daemon-composed` as a recognized but unsupported/deferred mode
- `collectionMode = lite | diagnostic | review`
- `conversationId` reuse for `/api/runs`
- cross-workspace `conversationId` rejection before queue insertion
- `revise + skillId` only for non-legacy `business-context`
- final prompt composition inside daemon for legacy generate and business-context runs
- `businessContext` hash and optional full snapshot at create time
- prompt/skill snapshot hash, size, persisted flags, and snapshot tables at start time
- skill side-file manifest metadata
- profile/client permission caps for `collectionMode`

This Slice 1a does not implement:

- `daemon-composed` transcript building
- `contextPolicy`
- `conversation_seq`
- review bundle export
- feedback APIs
- RPA DSL validation
- Playwright execution
- RPA UI
- RPA-specific observability extension

## Deferred Slice 1b

Slice 1b will implement the generic daemon-composed continuation capability:

- `promptMode = daemon-composed`
- `contextPolicy`
- `conversation_seq` on `run_messages`
- stable cross-run transcript ordering
- transcript truncation and warning strategy
- daemon-composed run-service integration tests

RPA MVP does not depend on Slice 1b. Codegen hardening, natural-language generation, question-form follow-up, and verify-failure repair all use `business-context`.

## Contract To Preserve

- Existing legacy clients continue to send `prompt` and omit `promptMode`.
- `legacy generate + skillId + prompt` still injects skill instructions.
- `legacy revise + prompt` still forbids `skillId` and passes the user prompt unchanged.
- `runs.prompt` remains the user-visible request, not the final internal prompt.
- `run_messages.content` stores only user/assistant-visible conversation content.
- Daemon injects `SKILL.md` and staged side-file paths; business clients never read skill bodies.
- `collectionMode` controls persisted diagnostic material.
- `eventVisibility` controls SSE/API event visibility.
- The two axes are independent.
- `lite` stores `businessContext` hash but not full business context JSON.
- `diagnostic` and `review` may persist full prompt, skill body, and business context snapshots.
- Staged skill absolute roots are not written into final prompt text; they remain internal runner data such as `extraAllowedDirs`.

## Planned File Map

- Modify: `apps/daemon/src/core/run-types.ts`
  - Add prompt/collection mode constants, request fields, response fields, and `COLLECTION_MODE_NOT_ALLOWED`.
- Modify: `apps/daemon/src/http/validation.ts`
  - Add Zod schema for legacy/business-context matrix, collection mode, opaque business context, conversation id, and deferred daemon-composed rejection.
- Modify: `apps/daemon/src/config/profiles.ts`
  - Add `maxCollectionMode` to profiles with default `lite`.
- Modify: `apps/daemon/src/config/auth.ts`
  - Add `requireCollectionModeAccess`.
- Modify: `apps/daemon/src/db/schema.ts`
  - Add run columns and create snapshot tables.
- Modify: `apps/daemon/src/db/repositories.ts`
  - Persist expanded run fields, select/reuse conversations, reject mismatched conversation ownership via service, insert create-time context snapshots, and insert start-time prompt/skill snapshots.
- Create: `apps/daemon/src/core/snapshot-service.ts`
  - Compute stable hashes and char/byte counts.
- Modify: `apps/daemon/src/core/skill-staging.ts`
  - Return side-file manifest metadata for staged skills.
- Modify: `apps/daemon/src/core/prompt-composer.ts`
  - Compose prompts from legacy/business-context, optional skill, staged relative side-file paths, and opaque business context.
- Modify: `apps/daemon/src/core/run-service.ts`
  - Normalize run request, enforce collection caps and conversation ownership before queue insertion, resolve/stage skills for any run with `skillId`, compose final prompt, persist snapshots, and keep run messages clean.
- Modify: `apps/daemon/src/http/runs-routes.ts`
  - Return `conversationId`, `userMessageId`, and `assistantMessageId`.
- Tests:
  - `apps/daemon/src/http/__tests__/validation.test.ts`
  - `apps/daemon/src/config/__tests__/profiles.test.ts`
  - `apps/daemon/src/config/__tests__/auth.test.ts`
  - `apps/daemon/src/db/__tests__/schema.test.ts`
  - `apps/daemon/src/db/__tests__/repositories.test.ts`
  - `apps/daemon/src/core/__tests__/snapshot-service.test.ts`
  - `apps/daemon/src/core/__tests__/skill-staging.test.ts`
  - `apps/daemon/src/core/__tests__/prompt-composer.test.ts`
  - `apps/daemon/src/core/__tests__/run-service.test.ts`
  - `apps/daemon/src/http/__tests__/runs-routes.test.ts`
- Docs:
  - `docs/api-reference.md`
  - `docs/business-run-chat-integration-guide.md`
  - `docs/configuration-reference.md`

---

## Task 1: Public Types And HTTP Validation Matrix

**Files:**
- Modify: `apps/daemon/src/core/run-types.ts`
- Modify: `apps/daemon/src/http/validation.ts`
- Test: `apps/daemon/src/http/__tests__/validation.test.ts`

- [ ] **Step 1: Add legacy compatibility tests**

Add validation tests proving current callers still parse:

```ts
expect(createRunRequestSchema.parse({
  profileId: 'report-docx',
  workspaceId: 'ws_123',
  kind: 'generate',
  skillId: 'report-writer',
  prompt: 'Generate the report.'
})).toMatchObject({
  promptMode: undefined,
  prompt: 'Generate the report.'
});

expect(createRunRequestSchema.parse({
  profileId: 'report-docx',
  workspaceId: 'ws_123',
  kind: 'revise',
  prompt: 'Revise the report.'
})).toMatchObject({
  kind: 'revise',
  prompt: 'Revise the report.'
});
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/http/__tests__/validation.test.ts`

Expected: tests pass before implementation changes and remain green after the schema expands.

- [ ] **Step 2: Add business-context validation tests**

Add a positive test:

```ts
const parsed = createRunRequestSchema.parse({
  profileId: 'rpa-local',
  workspaceId: 'ws_123',
  conversationId: 'conv_123',
  kind: 'generate',
  promptMode: 'business-context',
  collectionMode: 'diagnostic',
  skillId: 'playwright-rpa-harden',
  currentPrompt: '请根据上传的 codegen 脚本完成加固',
  businessContext: {
    stage: 'codegen_harden',
    inputFiles: ['input/flow.py']
  },
  metadata: { business: 'rpa' }
});

expect(parsed.promptMode).toBe('business-context');
expect(parsed.currentPrompt).toContain('codegen');
expect(parsed.businessContext).toEqual({
  stage: 'codegen_harden',
  inputFiles: ['input/flow.py']
});
```

Add rejection tests:

```ts
expect(() => createRunRequestSchema.parse({
  profileId: 'rpa-local',
  workspaceId: 'ws_123',
  kind: 'generate',
  promptMode: 'business-context',
  skillId: 'playwright-rpa-harden',
  prompt: 'raw prompt is forbidden here',
  currentPrompt: 'current prompt'
})).toThrow();

expect(() => createRunRequestSchema.parse({
  profileId: 'rpa-local',
  workspaceId: 'ws_123',
  kind: 'generate',
  promptMode: 'business-context',
  skillId: 'playwright-rpa-harden'
})).toThrow();

expect(() => createRunRequestSchema.parse({
  profileId: 'rpa-local',
  workspaceId: 'ws_123',
  kind: 'revise',
  promptMode: 'business-context',
  currentPrompt: '用户已回答参数问题'
})).toThrow();
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/http/__tests__/validation.test.ts`

Expected: new tests fail until `business-context` is supported.

- [ ] **Step 3: Add deferred daemon-composed validation test**

Add:

```ts
expect(() => createRunRequestSchema.parse({
  profileId: 'general-agent',
  workspaceId: 'ws_123',
  conversationId: 'conv_123',
  kind: 'revise',
  promptMode: 'daemon-composed',
  currentPrompt: '继续刚才的修改'
})).toThrow(/deferred|not supported/i);
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/http/__tests__/validation.test.ts`

Expected: test fails until the schema recognizes the value and rejects it intentionally.

- [ ] **Step 4: Add run type constants and request fields**

In `apps/daemon/src/core/run-types.ts`, add:

```ts
export const promptModes = ['legacy', 'business-context', 'daemon-composed'] as const;
export type PromptMode = (typeof promptModes)[number];

export const activePromptModes = ['legacy', 'business-context'] as const;
export type ActivePromptMode = (typeof activePromptModes)[number];

export const collectionModes = ['lite', 'diagnostic', 'review'] as const;
export type CollectionMode = (typeof collectionModes)[number];
```

Update `CreateRunRequest`:

```ts
export interface CreateRunRequest {
  profileId: string;
  workspaceId: string;
  kind: RunKind;
  prompt?: string;
  currentPrompt?: string;
  conversationId?: string;
  promptMode?: PromptMode;
  collectionMode?: CollectionMode;
  businessContext?: Record<string, unknown>;
  skillId?: string;
  model?: string;
  artifactRuleIds?: string[];
  eventVisibility?: EventVisibility;
  metadata?: Record<string, unknown>;
}
```

Do not add `contextPolicy` in Slice 1a. It belongs to Slice 1b with `daemon-composed`.

Add `COLLECTION_MODE_NOT_ALLOWED` to `daemonErrorCodes`.

- [ ] **Step 5: Implement Zod validation matrix**

In `apps/daemon/src/http/validation.ts`, keep `prompt` optional in the base object and enforce:

```ts
const promptMode = value.promptMode ?? 'legacy';

if (promptMode === 'daemon-composed') {
  addIssue(context, 'promptMode', 'daemon-composed is deferred to Slice 1b');
  return;
}

if (promptMode === 'legacy') {
  if (!value.prompt) addIssue(context, 'prompt', 'legacy promptMode requires prompt');
  if (value.currentPrompt) addIssue(context, 'currentPrompt', 'legacy promptMode forbids currentPrompt');
  if (value.businessContext !== undefined) {
    addIssue(context, 'businessContext', 'legacy promptMode forbids businessContext');
  }
}

if (promptMode === 'business-context') {
  if (value.prompt) addIssue(context, 'prompt', 'business-context forbids prompt');
  if (!value.currentPrompt) addIssue(context, 'currentPrompt', 'business-context requires currentPrompt');
  if (!value.skillId) addIssue(context, 'skillId', 'business-context requires skillId for MVP');
}

if (promptMode === 'legacy' && value.kind === 'generate' && !value.skillId) {
  addIssue(context, 'skillId', 'legacy generate requires skillId');
}
if (promptMode === 'legacy' && value.kind === 'revise' && value.skillId) {
  addIssue(context, 'skillId', 'legacy revise forbids skillId');
}
```

Use:

```ts
function addIssue(context: z.RefinementCtx, path: string, message: string): void {
  context.addIssue({ code: 'custom', path: [path], message });
}
```

- [ ] **Step 6: Verify validation**

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/http/__tests__/validation.test.ts`

Expected: all validation tests pass.

---

## Task 2: Profile Collection Caps

**Files:**
- Modify: `apps/daemon/src/config/profiles.ts`
- Modify: `apps/daemon/src/config/auth.ts`
- Test: `apps/daemon/src/config/__tests__/profiles.test.ts`
- Test: `apps/daemon/src/config/__tests__/auth.test.ts`

- [ ] **Step 1: Add config tests**

Add tests proving `maxCollectionMode` defaults to `lite` and accepts `diagnostic` / `review`:

```ts
const config = parseDaemonConfig(rawConfigWithoutMaxCollectionMode, { env: {} });
expect(config.profiles[0]?.maxCollectionMode).toBe('lite');

const reviewConfig = parseDaemonConfig({
  ...rawConfig,
  profiles: [{ ...rawConfig.profiles[0], maxCollectionMode: 'review' }]
}, { env: {} });
expect(reviewConfig.profiles[0]?.maxCollectionMode).toBe('review');
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/config/__tests__/profiles.test.ts`

Expected: default assertion fails until profile parsing is updated.

- [ ] **Step 2: Add permission cap tests**

Add tests in `auth.test.ts`:

```ts
expect(() => requireCollectionModeAccess({
  client: { canReadLogs: false, canReadDebugEvents: false } as ClientConfig,
  profile: { id: 'p1', maxCollectionMode: 'lite' } as ProfileConfig,
  collectionMode: 'diagnostic'
})).toThrow(expect.objectContaining({ code: 'COLLECTION_MODE_NOT_ALLOWED', status: 403 }));

expect(() => requireCollectionModeAccess({
  client: { canReadLogs: true, canReadDebugEvents: false } as ClientConfig,
  profile: { id: 'p1', maxCollectionMode: 'diagnostic' } as ProfileConfig,
  collectionMode: 'diagnostic'
})).not.toThrow();

expect(() => requireCollectionModeAccess({
  client: { canReadLogs: true, canReadDebugEvents: true } as ClientConfig,
  profile: { id: 'p1', maxCollectionMode: 'review' } as ProfileConfig,
  collectionMode: 'review'
})).not.toThrow();
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/config/__tests__/auth.test.ts`

Expected: tests fail until helper exists.

- [ ] **Step 3: Implement profile parsing**

In `ProfileConfig`, add:

```ts
maxCollectionMode: CollectionMode;
```

In `profileSchema`, add:

```ts
maxCollectionMode: z.enum(collectionModes).default('lite'),
```

Import `collectionModes` and `type CollectionMode` from `../core/run-types.js`.

- [ ] **Step 4: Implement cap helper**

In `apps/daemon/src/config/auth.ts`, add:

```ts
const collectionModeRank = {
  lite: 0,
  diagnostic: 1,
  review: 2,
} as const;

export function requireCollectionModeAccess(input: {
  client: ClientConfig;
  profile: Pick<ProfileConfig, 'id' | 'maxCollectionMode'>;
  collectionMode: CollectionMode;
}): void {
  if (collectionModeRank[input.collectionMode] > collectionModeRank[input.profile.maxCollectionMode]) {
    throw daemonError('COLLECTION_MODE_NOT_ALLOWED', 'Collection mode is not allowed for profile', 403, {
      profileId: input.profile.id,
      collectionMode: input.collectionMode,
      maxCollectionMode: input.profile.maxCollectionMode,
    });
  }

  if (input.collectionMode === 'diagnostic' && !input.client.canReadLogs) {
    throw daemonError('COLLECTION_MODE_NOT_ALLOWED', 'Diagnostic collection requires log access', 403);
  }

  if (
    input.collectionMode === 'review' &&
    (!input.client.canReadLogs || !input.client.canReadDebugEvents)
  ) {
    throw daemonError('COLLECTION_MODE_NOT_ALLOWED', 'Review collection requires log and debug access', 403);
  }
}
```

- [ ] **Step 5: Verify profile/auth tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- src/config/__tests__/profiles.test.ts
pnpm --filter @lance-agent-runner/daemon test -- src/config/__tests__/auth.test.ts
```

Expected: both test files pass.

---

## Task 3: Schema And Repository Persistence

**Files:**
- Modify: `apps/daemon/src/db/schema.ts`
- Modify: `apps/daemon/src/db/repositories.ts`
- Test: `apps/daemon/src/db/__tests__/schema.test.ts`
- Test: `apps/daemon/src/db/__tests__/repositories.test.ts`

- [ ] **Step 1: Add schema tests**

Add assertions that these run columns exist:

```ts
expect(runColumns).toEqual(expect.arrayContaining([
  'prompt_mode',
  'current_prompt',
  'collection_mode',
  'prompt_snapshot_hash',
  'prompt_snapshot_char_count',
  'prompt_snapshot_byte_count',
  'prompt_snapshot_persisted',
  'business_context_hash'
]));
```

Add assertions that these tables exist:

```ts
expect(tableNames).toEqual(expect.arrayContaining([
  'run_prompt_snapshots',
  'run_skill_snapshots',
  'run_context_snapshots'
]));
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/db/__tests__/schema.test.ts`

Expected: tests fail until schema changes are added.

- [ ] **Step 2: Add schema columns and snapshot tables**

Extend `runs` creation with:

```sql
prompt_mode TEXT NOT NULL DEFAULT 'legacy',
current_prompt TEXT,
collection_mode TEXT NOT NULL DEFAULT 'lite',
prompt_snapshot_hash TEXT,
prompt_snapshot_char_count INTEGER,
prompt_snapshot_byte_count INTEGER,
prompt_snapshot_persisted INTEGER NOT NULL DEFAULT 0,
business_context_hash TEXT,
```

Add tables:

```sql
CREATE TABLE IF NOT EXISTS run_prompt_snapshots (
  run_id TEXT PRIMARY KEY,
  prompt_snapshot TEXT,
  prompt_snapshot_hash TEXT,
  char_count INTEGER,
  byte_count INTEGER,
  persisted INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_skill_snapshots (
  run_id TEXT PRIMARY KEY,
  skill_id TEXT,
  skill_name TEXT,
  skill_description TEXT,
  skill_body_hash TEXT,
  skill_body TEXT,
  side_files_manifest_json TEXT,
  persisted INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_context_snapshots (
  run_id TEXT PRIMARY KEY,
  business_context_json TEXT,
  business_context_hash TEXT,
  persisted INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);
```

For existing databases, add idempotent column migration helpers following the existing `ensureRunMessagesThinkingContentColumn` pattern.

- [ ] **Step 3: Add repository tests for explicit conversation reuse**

Add a repository test that creates two runs with the same explicit conversation id and confirms both user messages belong to the same conversation:

```ts
const first = createRunQueuedWithMessagesAndSnapshot(db, {
  runId: 'run_1',
  conversationId: 'conv_shared',
  defaultConversationId: 'conv_default_1',
  userMessageId: 'msg_user_1',
  assistantMessageId: 'msg_assistant_1',
  workspaceId: 'ws_1',
  profileId: 'report-docx',
  clientId: 'client_1',
  kind: 'generate',
  skillId: 'report-writer',
  prompt: 'Visible request',
  promptMode: 'business-context',
  currentPrompt: 'Visible request',
  collectionMode: 'diagnostic',
  artifactRuleIds: [],
  metadata: undefined,
  profileSnapshot: {},
  businessContextHash: 'a'.repeat(64),
  businessContext: { stage: 'codegen_harden' },
  persistBusinessContext: true,
  now: 1000
});

const second = createRunQueuedWithMessagesAndSnapshot(db, {
  runId: 'run_2',
  conversationId: 'conv_shared',
  defaultConversationId: 'conv_default_2',
  userMessageId: 'msg_user_2',
  assistantMessageId: 'msg_assistant_2',
  workspaceId: 'ws_1',
  profileId: 'report-docx',
  clientId: 'client_1',
  kind: 'revise',
  skillId: 'report-writer',
  prompt: 'Visible follow-up',
  promptMode: 'business-context',
  currentPrompt: 'Visible follow-up',
  collectionMode: 'diagnostic',
  artifactRuleIds: [],
  metadata: undefined,
  profileSnapshot: {},
  businessContextHash: 'b'.repeat(64),
  businessContext: { previousRunId: 'run_1' },
  persistBusinessContext: true,
  now: 2000
});

expect(first.conversation.id).toBe('conv_shared');
expect(second.conversation.id).toBe('conv_shared');
expect(getRunMessages(db, 'run_1')[0]?.content).toBe('Visible request');
expect(getRunMessages(db, 'run_1')[0]?.content).not.toContain('## Skill instructions');
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/db/__tests__/repositories.test.ts`

Expected: tests fail until repositories accept explicit conversations and new run fields.

- [ ] **Step 4: Add create-time context snapshot tests**

Add tests proving diagnostic stores full business context and lite stores only hash:

```ts
const diagnostic = createRunQueuedWithMessagesAndSnapshot(db, {
  runId: 'run_diag',
  conversationId: undefined,
  defaultConversationId: 'conv_diag',
  userMessageId: 'msg_user_diag',
  assistantMessageId: 'msg_assistant_diag',
  workspaceId: 'ws_1',
  profileId: 'report-docx',
  clientId: 'client_1',
  kind: 'generate',
  skillId: 'report-writer',
  prompt: 'Visible request',
  promptMode: 'business-context',
  currentPrompt: 'Visible request',
  collectionMode: 'diagnostic',
  artifactRuleIds: [],
  metadata: undefined,
  profileSnapshot: {},
  businessContextHash: 'c'.repeat(64),
  businessContext: { inputFiles: ['input/flow.py'] },
  persistBusinessContext: true,
  now: 1000
});

expect(getRunContextSnapshot(db, diagnostic.run.id)).toMatchObject({
  businessContext: { inputFiles: ['input/flow.py'] },
  persisted: true
});

const lite = createRunQueuedWithMessagesAndSnapshot(db, {
  runId: 'run_lite',
  conversationId: undefined,
  defaultConversationId: 'conv_lite',
  userMessageId: 'msg_user_lite',
  assistantMessageId: 'msg_assistant_lite',
  workspaceId: 'ws_1',
  profileId: 'report-docx',
  clientId: 'client_1',
  kind: 'generate',
  skillId: 'report-writer',
  prompt: 'Visible request',
  promptMode: 'business-context',
  currentPrompt: 'Visible request',
  collectionMode: 'lite',
  artifactRuleIds: [],
  metadata: undefined,
  profileSnapshot: {},
  businessContextHash: 'd'.repeat(64),
  businessContext: { inputFiles: ['input/flow.py'] },
  persistBusinessContext: false,
  now: 1000
});

expect(getRunContextSnapshot(db, lite.run.id)).toMatchObject({
  businessContext: null,
  businessContextHash: 'd'.repeat(64),
  persisted: false
});
```

- [ ] **Step 5: Update repository mappings**

Extend `RunRecord` and `RunRow`:

```ts
promptMode: PromptMode;
currentPrompt: string | null;
collectionMode: CollectionMode;
promptSnapshotHash: string | null;
promptSnapshotCharCount: number | null;
promptSnapshotByteCount: number | null;
promptSnapshotPersisted: boolean;
businessContextHash: string | null;
```

Update `insertRunQueued` input and SQL to include those fields.

Add:

```ts
export function getConversationForWorkspace(
  db: RunnerDatabase,
  input: { conversationId: string; workspaceId: string },
): ConversationRecord | null;
```

Repository returns `null` on ownership mismatch. It does not throw generic errors for cross-workspace checks.

- [ ] **Step 6: Update create-run transaction**

Update `createRunQueuedWithMessagesAndSnapshot` input:

```ts
conversationId?: string;
defaultConversationId: string;
businessContext?: unknown;
businessContextHash?: string | null;
persistBusinessContext: boolean;
```

Conversation selection:

```ts
const conversation = input.conversationId
  ? getConversationForWorkspace(db, { conversationId: input.conversationId, workspaceId: input.workspaceId })
  : getOrCreateDefaultConversation(db, {
      id: input.defaultConversationId,
      workspaceId: input.workspaceId,
      now: input.now,
    });

if (!conversation) {
  throw new Error('Repository caller must validate conversation ownership before insert');
}
```

The service must validate ownership before calling this function. The repository guard is only defensive.

Use `input.currentPrompt ?? input.prompt` for user message content.

Within the same transaction, insert `run_context_snapshots` for any run with a business context hash. In `lite`, store `business_context_json = null`; in `diagnostic/review`, store full JSON.

- [ ] **Step 7: Add start-time snapshot repository functions**

Add:

```ts
export function upsertRunPromptSnapshot(db: RunnerDatabase, input: {
  runId: string;
  promptSnapshot: string | null;
  promptSnapshotHash: string;
  charCount: number;
  byteCount: number;
  persisted: boolean;
  now: number;
}): void;

export function updateRunPromptSnapshotFields(db: RunnerDatabase, input: {
  runId: string;
  promptSnapshotHash: string;
  charCount: number;
  byteCount: number;
  persisted: boolean;
  now: number;
}): void;

export function upsertRunSkillSnapshot(db: RunnerDatabase, input: {
  runId: string;
  skillId: string | null;
  skillName: string | null;
  skillDescription: string | null;
  skillBodyHash: string | null;
  skillBody: string | null;
  sideFilesManifest: unknown;
  persisted: boolean;
  now: number;
}): void;
```

Add read helpers used by tests and later review tooling:

```ts
export function getRunPromptSnapshot(
  db: RunnerDatabase,
  runId: string,
): RunPromptSnapshotRecord | null;

export function getRunSkillSnapshot(
  db: RunnerDatabase,
  runId: string,
): RunSkillSnapshotRecord | null;

export function getRunContextSnapshot(
  db: RunnerDatabase,
  runId: string,
): RunContextSnapshotRecord | null;
```

Use `INSERT OR REPLACE` for snapshot rows.

- [ ] **Step 8: Verify DB tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- src/db/__tests__/schema.test.ts
pnpm --filter @lance-agent-runner/daemon test -- src/db/__tests__/repositories.test.ts
```

Expected: schema and repository tests pass.

---

## Task 4: Snapshot Service

**Files:**
- Create: `apps/daemon/src/core/snapshot-service.ts`
- Test: `apps/daemon/src/core/__tests__/snapshot-service.test.ts`

- [ ] **Step 1: Add snapshot service tests**

Create tests:

```ts
import { describe, expect, it } from 'vitest';
import {
  createTextSnapshot,
  shouldPersistFullSnapshot,
  stableJsonHash,
} from '../snapshot-service.js';

describe('snapshot service', () => {
  it('hashes text and counts chars and bytes', () => {
    const snapshot = createTextSnapshot('abc公安');
    expect(snapshot.charCount).toBe(5);
    expect(snapshot.byteCount).toBe(Buffer.byteLength('abc公安', 'utf8'));
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists full snapshots only outside lite mode', () => {
    expect(shouldPersistFullSnapshot('lite')).toBe(false);
    expect(shouldPersistFullSnapshot('diagnostic')).toBe(true);
    expect(shouldPersistFullSnapshot('review')).toBe(true);
  });

  it('hashes JSON stably', () => {
    expect(stableJsonHash({ b: 2, a: 1 })).toBe(stableJsonHash({ a: 1, b: 2 }));
  });
});
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/core/__tests__/snapshot-service.test.ts`

Expected: test file fails until service exists.

- [ ] **Step 2: Implement snapshot helpers**

Create:

```ts
import { createHash } from 'node:crypto';
import type { CollectionMode } from './run-types.js';

export interface TextSnapshot {
  hash: string;
  charCount: number;
  byteCount: number;
}

export function createTextSnapshot(value: string): TextSnapshot {
  return {
    hash: sha256(value),
    charCount: Array.from(value).length,
    byteCount: Buffer.byteLength(value, 'utf8'),
  };
}

export function shouldPersistFullSnapshot(collectionMode: CollectionMode): boolean {
  return collectionMode !== 'lite';
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function stableJsonHash(value: unknown): string {
  return sha256(stableJsonStringify(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, innerValue]) => [key, sortJson(innerValue)]),
  );
}
```

- [ ] **Step 3: Verify snapshot tests**

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/core/__tests__/snapshot-service.test.ts`

Expected: tests pass.

---

## Task 5: Skill Staging Manifest

**Files:**
- Modify: `apps/daemon/src/core/skill-staging.ts`
- Test: `apps/daemon/src/core/__tests__/skill-staging.test.ts`

- [ ] **Step 1: Add manifest test**

Add a test that stages a skill with `references/style.md` and `templates/base.py`, then asserts:

```ts
expect(staged.sideFilesManifest).toEqual(expect.arrayContaining([
  expect.objectContaining({
    relativePath: 'references/style.md',
    size: expect.any(Number),
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
  }),
  expect.objectContaining({
    relativePath: 'templates/base.py',
    size: expect.any(Number),
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
  })
]));
expect(JSON.stringify(staged.sideFilesManifest)).not.toContain(skillSourceDir);
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/core/__tests__/skill-staging.test.ts`

Expected: test fails until staged skill includes manifest metadata.

- [ ] **Step 2: Implement manifest creation**

Extend `StagedSkill`:

```ts
export interface StagedSkillSideFile {
  relativePath: string;
  size: number;
  sha256: string;
}

export interface StagedSkill {
  relativeRoot: string;
  absoluteRoot: string;
  folderName: string;
  sideFilesManifest: StagedSkillSideFile[];
}
```

After copying the skill directory, recursively walk `absoluteRoot`, skip `SKILL.md`, hash file content, and store POSIX-style paths relative to `absoluteRoot`.

- [ ] **Step 3: Verify skill staging tests**

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/core/__tests__/skill-staging.test.ts`

Expected: tests pass.

---

## Task 6: Prompt Composer For Legacy And Business Context

**Files:**
- Modify: `apps/daemon/src/core/prompt-composer.ts`
- Test: `apps/daemon/src/core/__tests__/prompt-composer.test.ts`

- [ ] **Step 1: Update legacy revise test**

Keep the legacy revise behavior:

```ts
expect(composeRunPrompt({
  promptMode: 'legacy',
  kind: 'revise',
  currentPrompt: 'Please revise the attached document.'
})).toBe('Please revise the attached document.');
```

- [ ] **Step 2: Add business-context skill injection test**

Add:

```ts
const prompt = composeRunPrompt({
  promptMode: 'business-context',
  kind: 'revise',
  currentPrompt: '根据用户确认继续更新 flow',
  businessContext: {
    previousRunId: 'run_1',
    artifactPaths: ['output/flow.dsl.json'],
    formAnswers: { dateRange: '2026-06-01..2026-06-05' },
    stage: 'parameterize'
  },
  skill: makeSkill(),
  stagedSkill: {
    relativeRoot: '.claude-runner-skills/report-writer',
    absoluteRoot: '/tmp/workspace/.claude-runner-skills/report-writer',
    folderName: 'report-writer',
    sideFilesManifest: [{ relativePath: 'references/style.md', size: 10, sha256: 'a'.repeat(64) }]
  }
});

expect(prompt).toContain('## Skill instructions');
expect(prompt).toContain('## Current user request');
expect(prompt).toContain('根据用户确认继续更新 flow');
expect(prompt).toContain('## Business context');
expect(prompt).toContain('"previousRunId": "run_1"');
expect(prompt).toContain('Skill root (relative to workspace): `.claude-runner-skills/report-writer/`');
expect(prompt).not.toContain('/tmp/workspace');
expect(prompt).not.toContain('解析 DSL');
expect(prompt).not.toContain('运行 Playwright');
```

The final assertions prove daemon does not author RPA semantics and does not inject sandbox absolute paths into prompt text.

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/core/__tests__/prompt-composer.test.ts`

Expected: tests fail until composer supports business-context and removes absolute path guidance.

- [ ] **Step 3: Implement composer input**

Change `ComposeRunPromptInput`:

```ts
export interface ComposeRunPromptInput {
  kind: RunKind;
  promptMode: ActivePromptMode;
  currentPrompt: string;
  skill?: PromptSkill;
  stagedSkill?: StagedSkill;
  businessContext?: Record<string, unknown>;
}
```

Rules:

- `legacy + revise`: return `currentPrompt`.
- Any input with `skill`: inject skill metadata, staged relative path, side-file manifest, `SKILL.md` body, then current request.
- `business-context`: include `## Business context` with stable pretty JSON when `businessContext` exists.
- Do not include `stagedSkill.absoluteRoot` in final prompt text.

- [ ] **Step 4: Verify prompt composer tests**

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/core/__tests__/prompt-composer.test.ts`

Expected: tests pass and no test expects absolute staged paths in final prompt text.

---

## Task 7: Run Service Integration

**Files:**
- Modify: `apps/daemon/src/core/run-service.ts`
- Modify: `apps/daemon/src/db/repositories.ts`
- Test: `apps/daemon/src/core/__tests__/run-service.test.ts`

- [ ] **Step 1: Update existing createRun return-value assertions**

Update existing strict assertions such as:

```ts
expect(result).toEqual({ runId: 'run_1', status: 'queued' });
```

to:

```ts
expect(result).toEqual({
  runId: 'run_1',
  status: 'queued',
  conversationId: 'conv_1',
  userMessageId: 'msg_user',
  assistantMessageId: 'msg_assistant',
});
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/core/__tests__/run-service.test.ts`

Expected: tests fail until service response is extended.

- [ ] **Step 2: Add business-context generate test**

Business-context success-path tests that request `collectionMode: 'diagnostic'` must raise the test profile cap. Keep the collection-cap rejection test on the default `lite` profile.

Use setup shaped like:

```ts
const { config, db, workspace, service, runners, runNextTimer, root } = setup({
  configure: (testConfig) => {
    testConfig.profiles[0]!.maxCollectionMode = 'diagnostic';
  },
});
writeSkill(root, { sideFiles: true });
```

Add:

```ts
const result = service.createRun({
  client: config.clients[0]!,
  request: {
    profileId: 'report-docx',
    workspaceId: workspace.id,
    kind: 'generate',
    promptMode: 'business-context',
    collectionMode: 'diagnostic',
    skillId: 'report-writer',
    currentPrompt: '请根据 input/flow.py 完成加固',
    businessContext: { stage: 'codegen_harden', inputFiles: ['input/flow.py'] }
  }
});

expect(result).toEqual({
  runId: 'run_1',
  status: 'queued',
  conversationId: 'conv_1',
  userMessageId: 'msg_user',
  assistantMessageId: 'msg_assistant',
});

expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.messages[0]).toMatchObject({
  role: 'user',
  content: '请根据 input/flow.py 完成加固'
});
```

After scheduled start:

```ts
expect(runners[0]?.input.prompt).toContain('## Skill instructions');
expect(runners[0]?.input.prompt).toContain('## Business context');
expect(runners[0]?.input.prompt).toContain('input/flow.py');
expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.messages[0]?.content)
  .not.toContain('## Skill instructions');
expect(getRunPromptSnapshot(db, 'run_1')?.promptSnapshot).toContain('## Skill instructions');
expect(getRunPromptSnapshot(db, 'run_1')?.promptSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
expect(getRunPromptSnapshot(db, 'run_1')?.charCount).toBeGreaterThan(0);

const skillSnapshot = getRunSkillSnapshot(db, 'run_1');
expect(skillSnapshot).toMatchObject({
  skillId: 'report-writer',
  persisted: true,
});
expect(skillSnapshot?.skillBodyHash).toMatch(/^[a-f0-9]{64}$/);
expect(skillSnapshot?.skillBody).toContain('Use references/style.md');
expect(skillSnapshot?.sideFilesManifest).toEqual(expect.arrayContaining([
  expect.objectContaining({
    relativePath: 'references/style.md',
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  }),
]));
```

- [ ] **Step 3: Add business-context revise + skillId test**

This success-path test also uses `collectionMode: 'diagnostic'`, so configure the profile cap as in Step 2 and make the skill available with `writeSkill(root)`.

Add:

```ts
service.createRun({
  client: config.clients[0]!,
  request: {
    profileId: 'report-docx',
    workspaceId: workspace.id,
    kind: 'revise',
    promptMode: 'business-context',
    collectionMode: 'diagnostic',
    skillId: 'report-writer',
    currentPrompt: '用户已回答参数问题，请更新产物',
    businessContext: {
      previousRunId: 'run_previous',
      artifactPaths: ['output/flow.dsl.json'],
      formAnswers: { unit: 'A单位' },
      stage: 'parameterize'
    }
  }
});

await runScheduledStart(runNextTimer);
expect(runners[0]?.input.prompt).toContain('## Skill instructions');
expect(runners[0]?.input.prompt).toContain('"previousRunId": "run_previous"');
```

- [ ] **Step 4: Add collection cap rejection test**

Configure profile `maxCollectionMode: 'lite'` and create a client without log permissions:

```ts
expect(() => service.createRun({
  client: config.clients[0]!,
  request: {
    profileId: 'report-docx',
    workspaceId: workspace.id,
    kind: 'generate',
    promptMode: 'business-context',
    collectionMode: 'diagnostic',
    skillId: 'report-writer',
    currentPrompt: 'Run diagnostic'
  }
})).toThrow(expect.objectContaining({ code: 'COLLECTION_MODE_NOT_ALLOWED', status: 403 }));

expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })).toBeNull();
```

- [ ] **Step 5: Add cross-workspace conversationId rejection test**

Create a conversation under another workspace and assert the run is rejected before insertion:

```ts
expect(() => service.createRun({
  client: config.clients[0]!,
  request: {
    profileId: 'report-docx',
    workspaceId: workspace.id,
    conversationId: 'conv_other_workspace',
    kind: 'generate',
    promptMode: 'business-context',
    collectionMode: 'diagnostic',
    skillId: 'report-writer',
    currentPrompt: 'Run with mismatched conversation'
  }
})).toThrow(expect.objectContaining({ status: 400 }));

expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })).toBeNull();
```

The service should use `badRequest('Conversation does not belong to workspace')` or an equivalent structured 4xx, not a generic repository error.

- [ ] **Step 6: Add queued cancellation context snapshot test**

Create a diagnostic run, cancel it before scheduled start, and assert business context material exists:

Configure the profile cap as in Step 2. This test should still cancel before `runNextTimer()` is called.

```ts
const result = service.createRun({
  client: config.clients[0]!,
  request: {
    profileId: 'report-docx',
    workspaceId: workspace.id,
    kind: 'generate',
    promptMode: 'business-context',
    collectionMode: 'diagnostic',
    skillId: 'report-writer',
    currentPrompt: 'Prepare run',
    businessContext: { stage: 'codegen_harden', inputFiles: ['input/flow.py'] }
  }
});

service.cancelRun({ client: config.clients[0]!, runId: result.runId });

expect(getRunContextSnapshot(db, result.runId)).toMatchObject({
  businessContext: { stage: 'codegen_harden', inputFiles: ['input/flow.py'] },
  persisted: true
});
expect(getRunPromptSnapshot(db, result.runId)?.promptSnapshot ?? null).toBeNull();
```

This confirms create-time context snapshots do not depend on `startRun`.

- [ ] **Step 7: Add lite snapshot contrast test**

Create and start a `collectionMode: 'lite'` business-context run with the default profile cap. Assert context is hash-only:

```ts
expect(getRunContextSnapshot(db, result.runId)).toMatchObject({
  businessContext: null,
  persisted: false
});
expect(getRunContextSnapshot(db, result.runId)?.businessContextHash).toMatch(/^[a-f0-9]{64}$/);
```

After scheduled start, also assert prompt and skill snapshots are hash/metadata-only:

```ts
await runScheduledStart(runNextTimer);

const promptSnapshot = getRunPromptSnapshot(db, result.runId);
expect(promptSnapshot).toMatchObject({
  promptSnapshot: null,
  persisted: false,
});
expect(promptSnapshot?.promptSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
expect(promptSnapshot?.charCount).toBeGreaterThan(0);
expect(promptSnapshot?.byteCount).toBeGreaterThan(0);

const run = getRunDetail(db, { runId: result.runId, clientId: 'lqbot' })?.run;
expect(run?.promptSnapshotHash).toMatch(/^[a-f0-9]{64}$/);

const skillSnapshot = getRunSkillSnapshot(db, result.runId);
expect(skillSnapshot).toMatchObject({
  skillId: 'report-writer',
  skillBody: null,
  persisted: false,
});
expect(skillSnapshot?.skillBodyHash).toMatch(/^[a-f0-9]{64}$/);
expect(skillSnapshot?.sideFilesManifest).toEqual(expect.arrayContaining([
  expect.objectContaining({
    relativePath: 'references/style.md',
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  }),
]));
```

- [ ] **Step 8: Normalize run request inside service**

Add:

```ts
interface NormalizedRunRequest {
  promptMode: ActivePromptMode;
  collectionMode: CollectionMode;
  currentPrompt: string;
  conversationId?: string;
  skillId?: string;
  businessContext?: Record<string, unknown>;
  businessContextHash: string | null;
  persistBusinessContext: boolean;
}
```

Implement:

```ts
function normalizeRunRequest(request: CreateRunRequest): NormalizedRunRequest {
  const promptMode = request.promptMode ?? 'legacy';
  if (promptMode === 'daemon-composed') {
    throw badRequest('daemon-composed is deferred to Slice 1b');
  }
  const collectionMode = request.collectionMode ?? 'lite';
  const currentPrompt = promptMode === 'legacy' ? request.prompt! : request.currentPrompt!;
  const businessContextHash =
    request.businessContext === undefined ? null : stableJsonHash(request.businessContext);
  return {
    promptMode,
    collectionMode,
    currentPrompt,
    conversationId: request.conversationId,
    skillId: request.skillId,
    businessContext: request.businessContext,
    businessContextHash,
    persistBusinessContext: request.businessContext !== undefined && shouldPersistFullSnapshot(collectionMode),
  };
}
```

- [ ] **Step 9: Enforce caps, skill access, and conversation ownership before insertion**

In `createRun`:

```ts
const normalized = normalizeRunRequest(request);
requireCollectionModeAccess({ client, profile, collectionMode: normalized.collectionMode });

if (normalized.skillId) {
  assertSkillAllowedForProfile(profile, normalized.skillId);
}

if (normalized.conversationId) {
  const conversation = getConversationForWorkspace(input.db, {
    conversationId: normalized.conversationId,
    workspaceId: workspace.id,
  });
  if (!conversation) {
    throw badRequest('Conversation does not belong to workspace');
  }
}
```

This all happens before `createRunQueuedWithMessagesAndSnapshot`.

- [ ] **Step 10: Persist expanded run fields and create-time context snapshot**

Pass to repository:

```ts
conversationId: normalized.conversationId,
defaultConversationId: nextConversationId(),
prompt: normalized.currentPrompt,
promptMode: normalized.promptMode,
currentPrompt: normalized.currentPrompt,
collectionMode: normalized.collectionMode,
businessContextHash: normalized.businessContextHash,
businessContext: normalized.businessContext,
persistBusinessContext: normalized.persistBusinessContext,
```

Store `businessContext` through `run_context_snapshots`, never in `run_messages.content`.

- [ ] **Step 11: Resolve/stage skill whenever `skillId` exists**

In `startRun`, replace the old `if (state.kind === 'generate')` skill branch with a skill-id branch:

```ts
let skill: ResolvedSkill | null = null;
let stagedSkill: StagedSkill | undefined;

if (state.skillId) {
  skill = await resolveSkillForState(state);
  if (skill?.hasSideFiles) {
    stagedSkill = await stageSkillIntoWorkspace({
      workspaceCwd: getWorkspaceCwd(state.profile, state.workspace),
      skill,
    });
  }
}
```

Preserve the existing `skill.hasSideFiles` short-circuit. Do not stage no-side-file skills unnecessarily.

- [ ] **Step 12: Compose final prompt and persist start-time snapshots before runner start**

Compose:

```ts
const finalPrompt = composeRunPrompt({
  kind: state.kind,
  promptMode: state.promptMode,
  currentPrompt: state.currentPrompt,
  skill,
  stagedSkill,
  businessContext: state.businessContext,
});
```

Persist prompt and skill snapshots before `runnerFactory` receives `finalPrompt`:

```ts
const promptSnapshot = createTextSnapshot(finalPrompt);
const persistPrompt = shouldPersistFullSnapshot(state.collectionMode);

upsertRunPromptSnapshot(input.db, {
  runId: state.runId,
  promptSnapshot: persistPrompt ? finalPrompt : null,
  promptSnapshotHash: promptSnapshot.hash,
  charCount: promptSnapshot.charCount,
  byteCount: promptSnapshot.byteCount,
  persisted: persistPrompt,
  now: now(),
});

updateRunPromptSnapshotFields(input.db, {
  runId: state.runId,
  promptSnapshotHash: promptSnapshot.hash,
  charCount: promptSnapshot.charCount,
  byteCount: promptSnapshot.byteCount,
  persisted: persistPrompt,
  now: now(),
});
```

Skill snapshot body is persisted only when `shouldPersistFullSnapshot(collectionMode)` is true. Manifest/hash metadata is always persisted when a skill exists.

- [ ] **Step 13: Extend service response**

Change `RunService.createRun` return type:

```ts
{
  runId: string;
  status: 'queued';
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}
```

Build ids from repository result:

```ts
const userMessage = created.messages.find((message) => message.role === 'user');
const assistantMessage = created.messages.find((message) => message.role === 'assistant');
```

Return those ids. Keep HTTP response status `202`.

- [ ] **Step 14: Verify run-service tests**

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/core/__tests__/run-service.test.ts`

Expected: tests pass.

---

## Task 8: Public API Shape And Docs

**Files:**
- Modify: `apps/daemon/src/http/runs-routes.ts`
- Modify: `docs/api-reference.md`
- Modify: `docs/business-run-chat-integration-guide.md`
- Modify: `docs/configuration-reference.md`
- Test: `apps/daemon/src/http/__tests__/runs-routes.test.ts`

- [ ] **Step 1: Add route-level create response test**

Add/adjust:

```ts
expect(response.status).toBe(202);
expect(response.body).toEqual({
  runId: 'run_1',
  status: 'queued',
  conversationId: 'conv_1',
  userMessageId: 'msg_user',
  assistantMessageId: 'msg_assistant'
});
```

Run: `pnpm --filter @lance-agent-runner/daemon test -- src/http/__tests__/runs-routes.test.ts`

Expected: route test fails until service response and route serialization are aligned.

- [ ] **Step 2: Update API docs**

In `docs/api-reference.md`, update `POST /api/runs` fields:

```ts
promptMode?: 'legacy' | 'business-context' | 'daemon-composed';
prompt?: string;
currentPrompt?: string;
conversationId?: string;
collectionMode?: 'lite' | 'diagnostic' | 'review';
businessContext?: Record<string, unknown>;
```

Add:

```text
Slice 1a supports legacy and business-context. daemon-composed is reserved and rejected until Slice 1b.
legacy: prompt required, currentPrompt/businessContext forbidden.
business-context: currentPrompt and skillId required, prompt forbidden.
```

- [ ] **Step 3: Add business integration examples**

In `docs/business-run-chat-integration-guide.md`, add the four RPA-shaped generic examples:

```json
{
  "kind": "generate",
  "promptMode": "business-context",
  "skillId": "rpa-script-generate",
  "currentPrompt": "请生成下载数据的 RPA 流程",
  "businessContext": {
    "stage": "natural_language_generate",
    "targetUrl": "https://example.test"
  }
}
```

```json
{
  "kind": "generate",
  "promptMode": "business-context",
  "skillId": "playwright-rpa-harden",
  "currentPrompt": "请根据 codegen 脚本完成加固",
  "businessContext": {
    "stage": "codegen_harden",
    "inputFiles": ["input/flow.py"]
  }
}
```

```json
{
  "kind": "revise",
  "promptMode": "business-context",
  "skillId": "playwright-rpa-harden",
  "currentPrompt": "用户已确认参数，请继续更新产物",
  "businessContext": {
    "previousRunId": "run_123",
    "artifactPaths": ["output/flow.dsl.json", "output/flow.hardened.py"],
    "formAnswers": { "dateRange": "2026-06-01..2026-06-05" },
    "stage": "parameterize"
  }
}
```

```json
{
  "kind": "revise",
  "promptMode": "business-context",
  "skillId": "rpa-script-generate",
  "currentPrompt": "verify 失败，请根据失败信息修复脚本",
  "businessContext": {
    "stage": "verify_repair",
    "failedStepId": "download",
    "screenshotPath": "executions/ex_1/current.png",
    "logPath": "executions/ex_1/execution.log",
    "artifactPaths": ["output/flow.dsl.json", "output/flow.hardened.py"]
  }
}
```

State that daemon treats these fields as opaque business context.

- [ ] **Step 4: Update config docs**

In `docs/configuration-reference.md`, document:

```yaml
profiles:
  - id: rpa-local
    maxCollectionMode: diagnostic
clients:
  - id: rpa-web
    canReadLogs: true
    canReadDebugEvents: false
```

Explain:

```text
diagnostic requires canReadLogs.
review requires canReadLogs and canReadDebugEvents.
Requests above the allowed cap fail with COLLECTION_MODE_NOT_ALLOWED.
```

- [ ] **Step 5: Verify docs and route tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- src/http/__tests__/runs-routes.test.ts
rg -n "promptMode|collectionMode|business-context|daemon-composed|COLLECTION_MODE_NOT_ALLOWED" docs/api-reference.md docs/business-run-chat-integration-guide.md docs/configuration-reference.md
```

Expected: route tests pass and docs contain the Slice 1a contract.

---

## Task 9: Slice-Level Regression

**Files:**
- No additional files.

- [ ] **Step 1: Run focused daemon tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test -- \
  src/http/__tests__/validation.test.ts \
  src/config/__tests__/profiles.test.ts \
  src/config/__tests__/auth.test.ts \
  src/db/__tests__/schema.test.ts \
  src/db/__tests__/repositories.test.ts \
  src/core/__tests__/snapshot-service.test.ts \
  src/core/__tests__/skill-staging.test.ts \
  src/core/__tests__/prompt-composer.test.ts \
  src/core/__tests__/run-service.test.ts \
  src/http/__tests__/runs-routes.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run daemon quality gate**

Run:

```bash
pnpm test:daemon
pnpm typecheck:daemon
```

Expected: both commands pass.

- [ ] **Step 3: Run repo-level safety gate**

Run:

```bash
pnpm typecheck
pnpm build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 4: Inspect sensitive boundaries**

Run:

```bash
rg -n "## Skill instructions" apps/daemon/src/db apps/daemon/src/core apps/daemon/src/http
rg -n "absolute workspace path|absoluteRoot" apps/daemon/src/core/prompt-composer.ts apps/daemon/src/core/__tests__/prompt-composer.test.ts
rg -n "COLLECTION_MODE_NOT_ALLOWED|collectionMode|eventVisibility|daemon-composed|contextPolicy|conversation_seq" apps/daemon/src
```

Expected:

- `## Skill instructions` appears in composer/tests and snapshot tests only, not in code that writes `run_messages.content`.
- `prompt-composer.ts` does not inject staged absolute roots into final prompt.
- `collectionMode` and `eventVisibility` appear as separate concepts.
- `daemon-composed` appears only in type/validation deferred handling and docs.
- `contextPolicy` and `conversation_seq` are not implemented in Slice 1a.

- [ ] **Step 5: Commit the slice**

```bash
git add \
  apps/daemon/src/core/run-types.ts \
  apps/daemon/src/http/validation.ts \
  apps/daemon/src/config/profiles.ts \
  apps/daemon/src/config/auth.ts \
  apps/daemon/src/db/schema.ts \
  apps/daemon/src/db/repositories.ts \
  apps/daemon/src/core/snapshot-service.ts \
  apps/daemon/src/core/skill-staging.ts \
  apps/daemon/src/core/prompt-composer.ts \
  apps/daemon/src/core/run-service.ts \
  apps/daemon/src/http/runs-routes.ts \
  apps/daemon/src/http/__tests__/validation.test.ts \
  apps/daemon/src/config/__tests__/profiles.test.ts \
  apps/daemon/src/config/__tests__/auth.test.ts \
  apps/daemon/src/db/__tests__/schema.test.ts \
  apps/daemon/src/db/__tests__/repositories.test.ts \
  apps/daemon/src/core/__tests__/snapshot-service.test.ts \
  apps/daemon/src/core/__tests__/prompt-composer.test.ts \
  apps/daemon/src/core/__tests__/skill-staging.test.ts \
  apps/daemon/src/core/__tests__/run-service.test.ts \
  apps/daemon/src/http/__tests__/runs-routes.test.ts \
  docs/api-reference.md \
  docs/business-run-chat-integration-guide.md \
  docs/configuration-reference.md
git commit -m "Add daemon business context snapshot guard"
```

Expected: commit contains only Slice 1a files and does not include RPA Web, Slice 1b implementation, or unrelated docs.

---

## Known Follow-Up

- Add an independent byte limit for `businessContext` and return a structured error when exceeded. Slice 1a stores hashes and may persist full `businessContext` in `diagnostic/review`, so this limit should be added before broad production use, but it does not block the RPA MVP unblocking path.

---

## Self-Review

Spec coverage:

- Legacy compatibility is covered by Tasks 1, 6, and 7.
- `business-context` is covered by Tasks 1, 6, and 7.
- `revise + skillId` is covered by Tasks 1 and 7.
- Conversation reuse and ownership rejection are covered by Tasks 3 and 7.
- Create-time business context snapshot persistence is covered by Tasks 3 and 7.
- Start-time prompt/skill snapshots are covered by Tasks 3, 4, and 7.
- Collection permission caps are covered by Tasks 2 and 7.
- Public docs are covered by Task 8.
- Regression gates are covered by Task 9.

Boundary check:

- `daemon-composed`, `contextPolicy`, and `conversation_seq` are deferred to Slice 1b.
- No daemon task requires parsing RPA DSL or Playwright.
- RPA examples appear only as opaque business-context examples.
- No `run_events` table is introduced.
- Review bundle and feedback APIs stay outside this slice.

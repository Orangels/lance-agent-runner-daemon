# Async Runtime File I/O Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove synchronous filesystem I/O from daemon runtime request/run paths so PostgreSQL async persistence is not undermined by local file operations blocking the Node event loop.

**Architecture:** Keep PostgreSQL persistence as-is and convert runtime filesystem operations in `apps/daemon/src/core` to `node:fs/promises` or stream-based async helpers. Add a static guard test so future runtime code cannot reintroduce `*Sync` filesystem calls outside explicitly allowed startup/migration/test-only modules. Preserve public HTTP response shapes and run lifecycle semantics, especially artifact-before-terminal and durable log availability.

**Tech Stack:** TypeScript ESM, Node `fs/promises`, Node streams, Vitest, existing daemon service boundaries.

---

## Scope

In scope:

- `apps/daemon/src/core/workspace-service.ts`
- `apps/daemon/src/core/run-log-service.ts`
- `apps/daemon/src/core/review-bundle-service.ts`
- `apps/daemon/src/core/upload-temp-service.ts`
- `apps/daemon/src/core/daemon-logger.ts`
- call sites/tests affected by async signatures
- static guard test for runtime sync filesystem calls
- docs note for async runtime file I/O boundary

Out of scope:

- `apps/daemon/src/db/migration/*`: migration tools intentionally use SQLite and some sync filesystem reads.
- `apps/daemon/src/db/connection.ts`: legacy SQLite helper kept for tests/migration compatibility, not runtime startup.
- `apps/daemon/src/config/config.ts`: startup-only config read may remain synchronous unless a later startup-hardening plan changes it.
- `apps/daemon/tests/**`: tests may keep sync file helpers for fixture setup and assertions.

## Current Runtime Blocking Points

Confirmed sync runtime points:

- `workspace-service.ts`: `mkdirSync`, `statSync`, `copyFileSync`
- `run-log-service.ts`: `mkdirSync`, `writeFileSync`, `existsSync`, `statSync`, `readFileSync`, `rmSync`
- `review-bundle-service.ts`: `readFileSync`
- `upload-temp-service.ts`: `mkdirSync`, `readdirSync`, `rmSync`, `rmdirSync`, `statSync`
- `daemon-logger.ts`: `mkdirSync`, `appendFileSync`

Already async or acceptable:

- PostgreSQL persistence uses `pg` async queries and transactions.
- Claude CLI uses async `spawn`.
- Capability probe uses async `execFile` callback.
- Artifact scanning already uses `fast-glob`, `fs/promises`, and stream hashing.
- HTTP artifact/log downloads use `createReadStream`.

## File Structure

- Modify `apps/daemon/src/core/workspace-service.ts`
  - Make workspace skeleton creation and file copy async.
  - Use `mkdir`, `stat`, `copyFile` from `node:fs/promises`.

- Modify `apps/daemon/src/core/upload-temp-service.ts`
  - Convert service API to async for directory creation/removal/pruning.
  - Use `mkdir`, `readdir`, `rm`, `rmdir`, `stat` from `node:fs/promises`.
  - Update upload route call sites to `await` cleanup/prune as needed.

- Modify `apps/daemon/src/core/run-log-service.ts`
  - Convert log open/read/prune operations to async filesystem calls.
  - Replace sync bounded writer with queued async writer.
  - Change `RunLogHandle.close()` to `Promise<void>` and await it in run-service and tests.

- Modify `apps/daemon/src/core/run-events.ts`
  - Add a first-class `warning` event variant for non-terminal operational warnings.

- Modify `apps/daemon/src/core/event-visibility.ts`
  - Add `warning` to the exhaustive `eventVisibilityByType` map.

- Modify `apps/daemon/src/core/run-service.ts`
  - Await run log close before emitting the terminal `end` event.
  - Emit a durable warning event and write a daemon service log entry if log close fails.
  - Add an optional `daemonLogger` dependency so run-service can persist operational warnings without coupling to HTTP.

- Modify `apps/daemon/src/core/review-bundle-service.ts`
  - Replace sync log reads with async `readFile`.

- Modify `apps/daemon/src/core/daemon-logger.ts`
  - Replace sync append logger with a small queued async logger.
  - Keep `debug/info/warn/error` methods non-throwing and non-blocking for callers.
  - Add required `flush(): Promise<void>` and await it during daemon shutdown and fatal-error paths.

- Modify `apps/daemon/src/index.ts`
  - Await async upload temp pruning during startup context creation.
  - Pass `daemonLogger` into `createRunService`.
  - Await logger flush during graceful shutdown.
  - Best-effort flush logger after server errors and top-level fatal errors.

- Create `apps/daemon/tests/static/no-sync-runtime-io.test.ts`
  - Fails when runtime source files import `node:fs` sync methods or contain `*Sync` calls in `src/core`, `src/http`, or `src/index.ts`.
  - Allows `createReadStream` in HTTP download routes and artifact scanner.
  - Excludes `src/db/migration`, `src/db/connection.ts`, tests, and startup config.

- Modify affected tests:
  - `apps/daemon/tests/core/workspace-service.test.ts`
  - `apps/daemon/tests/core/run-log-service.test.ts`
  - `apps/daemon/tests/core/review-bundle-service.test.ts`
  - `apps/daemon/tests/http/logs-routes.test.ts`
  - `apps/daemon/tests/http/review-bundle-routes.test.ts`
  - `apps/daemon/tests/http/workspace-files-routes.test.ts`
  - `apps/daemon/tests/http/workspaces-routes.test.ts`
  - `apps/daemon/tests/index.test.ts`
  - `apps/daemon/tests/core/daemon-logger.test.ts`
  - `apps/daemon/tests/http/app-logging.test.ts`

---

## Task 1: Static Guard For Runtime Sync Filesystem Calls

**Files:**
- Create: `apps/daemon/tests/static/no-sync-runtime-io.test.ts`
- Modify if needed: `apps/daemon/tsconfig.test.json`

- [ ] **Step 1: Write the failing static test**

Create `apps/daemon/tests/static/no-sync-runtime-io.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fg from 'fast-glob';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const runtimeGlobs = [
  'src/core/**/*.ts',
  'src/http/**/*.ts',
  'src/index.ts',
];

const allowedFiles = new Set([
  // HTTP download routes and artifact scanner may create read streams without blocking.
  'src/http/artifacts-routes.ts',
  'src/http/logs-routes.ts',
  'src/core/artifact-scanner.ts',
]);

const allowedFsImports = new Map<string, Set<string>>([
  ['src/http/artifacts-routes.ts', new Set(['createReadStream'])],
  ['src/http/logs-routes.ts', new Set(['createReadStream'])],
  ['src/core/artifact-scanner.ts', new Set(['createReadStream'])],
]);

describe('runtime filesystem I/O', () => {
  it('does not use synchronous filesystem APIs in daemon runtime paths', async () => {
    const files = await fg(runtimeGlobs, {
      cwd: daemonRoot,
      absolute: false,
    });
    const violations: string[] = [];

    for (const file of files.sort()) {
      const source = await readFile(path.resolve(daemonRoot, file), 'utf8');
      const syncCalls = source.match(/\b[A-Za-z0-9_]+Sync\b/g) ?? [];
      for (const call of syncCalls) {
        violations.push(`${file}: synchronous call ${call}`);
      }

      const fsImport = source.match(/import\s+\{([^}]+)\}\s+from ['"]node:fs['"]/);
      if (!fsImport) {
        continue;
      }
      const importedNames = fsImport[1]!
        .split(',')
        .map((item) => item.trim().split(/\s+as\s+/)[0]!.trim())
        .filter(Boolean);
      const allowed = allowedFsImports.get(file) ?? new Set<string>();
      for (const importedName of importedNames) {
        if (!allowedFiles.has(file) || !allowed.has(importedName)) {
          violations.push(`${file}: imports node:fs ${importedName}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
```

This static guard is intentionally simple: it scans source text, so comments or strings containing `*Sync` can fail the test. If that happens, reword the comment/string rather than weakening the guard. Type-only imports such as `import type { Dirent } from 'node:fs'` are allowed because this test only rejects runtime `import { ... } from 'node:fs'` imports.

- [ ] **Step 2: Run the static test and verify it fails**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run tests/static/no-sync-runtime-io.test.ts
```

Expected: FAIL. The failure list should include current sync calls from `workspace-service.ts`, `run-log-service.ts`, `review-bundle-service.ts`, `upload-temp-service.ts`, and `daemon-logger.ts`.

- [ ] **Step 3: Commit the red test**

```bash
git add apps/daemon/tests/static/no-sync-runtime-io.test.ts
git commit -m "test: guard runtime async file io"
```

---

## Task 2: Async Workspace Directory And File Copy

**Files:**
- Modify: `apps/daemon/src/core/workspace-service.ts`
- Test: `apps/daemon/tests/core/workspace-service.test.ts`
- Test: `apps/daemon/tests/http/workspaces-routes.test.ts`
- Test: `apps/daemon/tests/http/workspace-files-routes.test.ts`

- [ ] **Step 1: Update workspace service tests to await async filesystem work**

Inspect existing tests and ensure every call already awaits:

```ts
await service.createOrGetWorkspace(...);
await service.prepareWorkspaceFiles(...);
await service.prepareUploadedWorkspaceFile(...);
```

If any test stores a promise result without `await`, update it to `await`.

- [ ] **Step 2: Replace sync imports**

In `apps/daemon/src/core/workspace-service.ts`, replace:

```ts
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
```

with:

```ts
import { copyFile, mkdir, stat } from 'node:fs/promises';
```

- [ ] **Step 3: Make workspace skeleton creation async**

Replace:

```ts
createWorkspaceSkeleton(input.profile, workspace);
```

with:

```ts
await createWorkspaceSkeleton(input.profile, workspace);
```

Change helper:

```ts
async function createWorkspaceSkeleton(profile: ProfileConfig, workspace: WorkspaceRecord): Promise<void> {
  const cwd = getWorkspaceCwd(profile, workspace);
  await Promise.all(
    ['input', 'output', 'work', '.claude-runner-skills'].map((directory) =>
      mkdir(resolveUnderRoot(cwd, directory), { recursive: true }),
    ),
  );
}
```

- [ ] **Step 4: Make workspace file copy async**

Before starting parallel copies, reject duplicate target paths so the async implementation does not introduce non-deterministic last-writer-wins behavior:

```ts
function assertNoDuplicateWorkspaceTargets(files: readonly { targetPath: string }[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const targetPath = assertWorkspaceRelativePath(file.targetPath);
    if (seen.has(targetPath)) {
      throw daemonError('BAD_REQUEST', 'Duplicate workspace target path', 400, {
        targetPath,
      });
    }
    seen.add(targetPath);
  }
}
```

Call it at the start of `prepareWorkspaceFiles`:

```ts
assertNoDuplicateWorkspaceTargets(input.files);
```

Change:

```ts
const files = input.files.map((file) => {
  const sourcePath = resolveAllowedSourcePath(input.profile.allowedInputRoots, file.sourcePath);
  return copyFileIntoWorkspace({ workspaceCwd: cwd, sourcePath, targetPath: file.targetPath });
});
```

to:

```ts
const files = await Promise.all(
  input.files.map((file) => {
    const sourcePath = resolveAllowedSourcePath(input.profile.allowedInputRoots, file.sourcePath);
    return copyFileIntoWorkspace({ workspaceCwd: cwd, sourcePath, targetPath: file.targetPath });
  }),
);
```

Change uploaded file path:

```ts
const file = await copyFileIntoWorkspace({
  workspaceCwd: cwd,
  sourcePath: input.sourcePath,
  targetPath: input.targetPath,
});
```

Replace helper with:

```ts
async function copyFileIntoWorkspace(input: {
  workspaceCwd: string;
  sourcePath: string;
  targetPath: string;
}): Promise<PreparedWorkspaceFile> {
  const targetPath = assertWorkspaceRelativePath(input.targetPath);
  const targetAbsolutePath = resolveUnderRoot(input.workspaceCwd, targetPath);
  try {
    if ((await stat(targetAbsolutePath)).isDirectory()) {
      throw daemonError('PATH_NOT_ALLOWED', 'Target path cannot be a directory', 400, {
        targetPath,
      });
    }
  } catch (error) {
    if (error instanceof DaemonError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
  await copyFile(input.sourcePath, targetAbsolutePath);
  const size = (await stat(targetAbsolutePath)).size;
  return { targetPath, size };
}
```

- [ ] **Step 5: Run workspace tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run \
  tests/core/workspace-service.test.ts \
  tests/http/workspaces-routes.test.ts \
  tests/http/workspace-files-routes.test.ts \
  tests/static/no-sync-runtime-io.test.ts
```

Expected: workspace tests PASS; static test still FAIL for remaining modules only.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/core/workspace-service.ts apps/daemon/tests/core/workspace-service.test.ts apps/daemon/tests/http/workspaces-routes.test.ts apps/daemon/tests/http/workspace-files-routes.test.ts
git commit -m "refactor: make workspace file io async"
```

---

## Task 3: Async Upload Temp Service

**Files:**
- Modify: `apps/daemon/src/core/upload-temp-service.ts`
- Modify: `apps/daemon/src/index.ts`
- Modify: `apps/daemon/src/http/workspace-files-routes.ts`
- Test: `apps/daemon/tests/core/upload-temp-service.test.ts`
- Test: `apps/daemon/tests/http/workspace-files-routes.test.ts`
- Test: `apps/daemon/tests/index.test.ts`

- [ ] **Step 1: Update service interface to async**

In `apps/daemon/src/core/upload-temp-service.ts`, change:

```ts
createUploadDirectory(): string;
removeUploadPath(filePath: string): void;
pruneExpiredUploads(input?: { now?: number }): { removed: number };
```

to:

```ts
createUploadDirectory(): Promise<string>;
removeUploadPath(filePath: string): Promise<void>;
pruneExpiredUploads(input?: { now?: number }): Promise<{ removed: number }>;
```

- [ ] **Step 2: Replace sync fs imports**

Replace:

```ts
import { mkdirSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
```

with:

```ts
import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
```

- [ ] **Step 3: Implement async temp directory operations**

Use this shape:

```ts
async function ensureTempRoot(): Promise<void> {
  await mkdir(tempRoot, { recursive: true });
}

createUploadDirectory: async () => {
  await ensureTempRoot();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const uploadDir = path.join(tempRoot, createUploadDirectoryName());
    try {
      await mkdir(uploadDir);
      return uploadDir;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
  throw new Error('Unable to create a unique upload directory');
},
removeUploadPath: async (filePath) => {
  const resolvedPath = assertTempPath(filePath);
  if (resolvedPath === tempRoot) {
    return;
  }

  await rm(resolvedPath, { recursive: true, force: true });

  const parent = path.dirname(resolvedPath);
  if (parent !== tempRoot && isPathInsideRoot(tempRoot, parent)) {
    try {
      await rmdir(parent);
    } catch (error) {
      if (!isIgnorableRemoveDirectoryError(error)) {
        throw error;
      }
    }
  }
},
pruneExpiredUploads: async (input = {}) => {
  await ensureTempRoot();
  const now = input.now ?? Date.now();
  const cutoff = now - serviceInput.config.server.uploadTempRetentionMs;
  let removed = 0;

  for (const entry of await readdir(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childPath = path.join(tempRoot, entry.name);
    if (childPath === tempRoot || !isPathInsideRoot(tempRoot, childPath)) {
      continue;
    }

    const childStat = await stat(childPath);
    if (childStat.mtimeMs < cutoff) {
      await rm(childPath, { recursive: true, force: true });
      removed += 1;
    }
  }

  return { removed };
},
```

- [ ] **Step 4: Await call sites**

In `apps/daemon/src/index.ts`, replace:

```ts
uploadTempService.pruneExpiredUploads({ now: startupNow });
```

with:

```ts
await uploadTempService.pruneExpiredUploads({ now: startupNow });
```

In `apps/daemon/src/http/workspace-files-routes.ts`, update multer's callback-style destination. Do not use `await` directly inside the callback unless the callback itself is marked async and all errors are converted back into `callback(error, '')`. Use the explicit promise form:

```ts
destination: (request, _file, callback) => {
  dependencies.uploadTempService
    .createUploadDirectory()
    .then((uploadDir) => {
      (request as UploadRequest).uploadDir = uploadDir;
      callback(null, uploadDir);
    })
    .catch((error: unknown) => {
      callback(error as Error, '');
    });
},
```

Change `cleanupUploadPath` to async while preserving the existing error semantics: success-path cleanup failures still fail the request, error-path cleanup failures remain suppressed.

```ts
async function cleanupUploadPath(
  request: UploadRequest,
  uploadTempService: UploadTempService,
  suppressErrors: boolean,
): Promise<void> {
  const cleanupPath = request.file?.path ?? request.uploadDir;
  if (!cleanupPath) {
    return;
  }

  try {
    await uploadTempService.removeUploadPath(cleanupPath);
  } catch (error) {
    if (!suppressErrors) {
      throw error;
    }
  }
}
```

Update both call sites:

```ts
await cleanupUploadPath(uploadRequest, dependencies.uploadTempService, true);
await cleanupUploadPath(uploadRequest, dependencies.uploadTempService, operationError !== undefined);
```

Only use `void promise.catch(...)` for temp cleanup after the response path is already settled. The upload route cleanup above is still part of the request lifecycle, so it must be awaited.

- [ ] **Step 5: Migrate existing upload temp service tests**

`apps/daemon/tests/core/upload-temp-service.test.ts` already exists and currently assumes synchronous service methods. Convert each test that calls async service methods to `async` and `await` those calls.

Change this pattern:

```ts
it('creates temp root and one unique upload directory', () => {
  const { dataDir, service } = setup();

  const uploadDir = service.createUploadDirectory();

  expect(service.getTempRoot()).toBe(path.join(dataDir, 'uploads', 'tmp'));
  expect(statSync(service.getTempRoot()).isDirectory()).toBe(true);
  expect(statSync(uploadDir).isDirectory()).toBe(true);
  expect(path.dirname(uploadDir)).toBe(service.getTempRoot());
  expect(readdirSync(service.getTempRoot())).toEqual([path.basename(uploadDir)]);
});
```

to:

```ts
it('creates temp root and one unique upload directory', async () => {
  const { dataDir, service } = setup();

  const uploadDir = await service.createUploadDirectory();

  expect(service.getTempRoot()).toBe(path.join(dataDir, 'uploads', 'tmp'));
  expect(statSync(service.getTempRoot()).isDirectory()).toBe(true);
  expect(statSync(uploadDir).isDirectory()).toBe(true);
  expect(path.dirname(uploadDir)).toBe(service.getTempRoot());
  expect(readdirSync(service.getTempRoot())).toEqual([path.basename(uploadDir)]);
});
```

Apply the same `async`/`await` migration to all existing async method calls:

```ts
const uploadDir = await service.createUploadDirectory();
await service.removeUploadPath(filePath);
const result = await service.pruneExpiredUploads({ now: 3_000 });
```

`assertTempPath` remains synchronous and should not be awaited.

- [ ] **Step 6: Run upload/temp tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run \
  tests/core/upload-temp-service.test.ts \
  tests/http/workspace-files-routes.test.ts \
  tests/index.test.ts \
  tests/static/no-sync-runtime-io.test.ts
```

Expected: upload temp service and upload route tests PASS. `tests/index.test.ts` may PASS or SKIP depending on PG availability. Static test should still FAIL for log/review/logger modules only.

When `CLAUDE_RUNNER_TEST_PG_URL` is absent, `tests/index.test.ts` may be skipped because that suite is PG-gated. That is acceptable for local iteration, but final verification must run once with PG configured.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/core/upload-temp-service.ts apps/daemon/src/index.ts apps/daemon/src/http/workspace-files-routes.ts apps/daemon/tests
git commit -m "refactor: make upload temp io async"
```

---

## Task 4: Async Run Log Service With Ordered Writes

**Files:**
- Modify: `apps/daemon/src/core/run-log-service.ts`
- Modify: `apps/daemon/src/core/run-service.ts`
- Modify: `apps/daemon/src/core/run-events.ts`
- Modify: `apps/daemon/src/core/event-visibility.ts`
- Modify: `apps/daemon/src/index.ts`
- Modify tests that call `logs.close()`
- Test: `apps/daemon/tests/core/run-log-service.test.ts`
- Test: `apps/daemon/tests/core/run-service.test.ts`
- Test: `apps/daemon/tests/http/logs-routes.test.ts`
- Test: `apps/daemon/tests/http/review-bundle-routes.test.ts`
- Test: `apps/daemon/tests/core/review-bundle-service.test.ts`

- [ ] **Step 1: Change `RunLogHandle.close` to async**

Change interface:

```ts
export interface RunLogHandle {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  debugEvent(event: RunEvent): void;
  close(): Promise<void>;
}
```

Keep `stdout/stderr/debugEvent` as `void` because `cli-runner` log sink callbacks are synchronous. Internally they must enqueue writes.

- [ ] **Step 1b: Add a warning run event type**

In `apps/daemon/src/core/run-events.ts`, add this variant to the `RunEvent` union:

```ts
  | {
      type: 'warning';
      message: string;
      code?: string;
      details?: unknown;
    }
```

In `apps/daemon/src/core/event-visibility.ts`, update the exhaustive map:

```ts
const eventVisibilityByType: Record<RunEvent['type'], EventVisibility> = {
  status: 'quiet',
  assistant_message_start: 'quiet',
  text_delta: 'quiet',
  usage: 'quiet',
  error: 'quiet',
  warning: 'quiet',
  artifact_finalized: 'quiet',
  end: 'quiet',
  thinking_start: 'normal',
  thinking_delta: 'normal',
  tool_use: 'normal',
  tool_result: 'debug',
  stderr: 'debug',
  raw: 'debug',
};
```

Use `warning` for operational degradation that does not change the terminal run status. Do not reuse the existing `error` event for run log close failure, because consumers may interpret `error` as a failed run.

- [ ] **Step 2: Replace sync fs imports**

Replace:

```ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
```

with:

```ts
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
```

- [ ] **Step 3: Implement a queued bounded async writer**

Replace `createBoundedWriter` with:

```ts
function createBoundedWriter(dataDir: string, relativePath: string, maxBytes: number) {
  const absolutePath = resolveInsideDataDir(dataDir, relativePath);
  let bytes = 0;
  let truncated = false;
  let queue = Promise.resolve();
  let failure: unknown = null;

  const enqueue = (operation: () => Promise<void>) => {
    queue = queue
      .then(operation)
      .catch((error) => {
        failure = error;
      });
  };

  return {
    async open(): Promise<void> {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, '');
    },
    append(text: string): void {
      if (truncated) return;
      const buffer = Buffer.from(text, 'utf8');
      enqueue(async () => {
        if (truncated) return;

        const availableBytes = maxBytes - bytes;
        if (buffer.byteLength <= availableBytes) {
          await writeFile(absolutePath, buffer, { flag: 'a' });
          bytes += buffer.byteLength;
          return;
        }

        if (availableBytes > 0) {
          await writeFile(absolutePath, buffer.subarray(0, availableBytes), { flag: 'a' });
          bytes += availableBytes;
        }
        await writeFile(absolutePath, truncationMarker, { flag: 'a' });
        truncated = true;
      });
    },
    async close(): Promise<void> {
      await queue;
      if (failure) {
        throw failure;
      }
    },
  };
}
```

- [ ] **Step 4: Open all log writers before persisting paths**

In `openRunLogs`, replace sync setup with:

```ts
await mkdir(runDir, { recursive: true });
const stdout = createBoundedWriter(dataDir, stdoutLogPath, input.config.server.maxLogBytesPerRun);
const stderr = createBoundedWriter(dataDir, stderrLogPath, input.config.server.maxLogBytesPerRun);
const debugEvents = createBoundedWriter(dataDir, debugEventsLogPath, input.config.server.maxLogBytesPerRun);
await Promise.all([stdout.open(), stderr.open(), debugEvents.open()]);
await persistence.upsertRunLogPaths({
  runId,
  stdoutLogPath,
  stderrLogPath,
  debugEventsLogPath,
  now: now(),
});
```

This code runs inside the existing `openRunLogs: async ({ runId }) => { ... }` method. Use the destructured `runId`, not `input.runId`. Use the service clock `now()` from `const now = input.clock ?? Date.now`, not `Date.now()`, so tests remain deterministic.

Return:

```ts
return {
  stdout: (chunk) => stdout.append(sanitizeLogText(chunk)),
  stderr: (chunk) => stderr.append(sanitizeLogText(chunk)),
  debugEvent: (event) => debugEvents.append(`${sanitizeLogText(JSON.stringify(event))}\n`),
  close: async () => {
    await Promise.all([stdout.close(), stderr.close(), debugEvents.close()]);
  },
};
```

- [ ] **Step 5: Make log reads/removal async**

Change `summarizeLogFile` to:

```ts
async function summarizeLogFile(dataDir: string, relativePath: string | null): Promise<PublicRunLogSummary> {
  if (relativePath === null) {
    return unavailableLog();
  }

  const absolutePath = resolveInsideDataDir(dataDir, relativePath);
  const safeStat = await stat(absolutePath).catch(() => null);
  if (!safeStat?.isFile()) {
    return unavailableLog();
  }

  const content = await readFile(absolutePath);
  const tail = content.subarray(Math.max(0, content.byteLength - logTailBytes)).toString('utf8');
  return {
    available: true,
    size: safeStat.size,
    tail,
  };
}
```

In `getRunLogs`, await each summary:

```ts
const [stdout, stderr, debugEvents] = await Promise.all([
  summarizeLogFile(dataDir, record?.stdoutLogPath ?? null),
  summarizeLogFile(dataDir, record?.stderrLogPath ?? null),
  summarizeLogFile(dataDir, record?.debugEventsLogPath ?? null),
]);
```

In `getRunLogDownload`, replace `existsSync/statSync` with:

```ts
const safeStat = await stat(absolutePath).catch(() => null);
if (!safeStat?.isFile()) {
  throw notFound('Run log not found');
}
```

In `pruneExpiredLogs`, replace:

```ts
rmSync(runDir, { recursive: true, force: true });
```

with:

```ts
await rm(runDir, { recursive: true, force: true });
```

- [ ] **Step 6: Await log close in run-service before terminal event**

Add an optional daemon logger dependency to `CreateRunServiceInput`:

```ts
import { noopDaemonLogger, type DaemonLogger } from './daemon-logger.js';

export interface CreateRunServiceInput {
  config: DaemonConfig;
  persistence?: RunnerPersistence;
  runnerFactory?: RunServiceRunnerFactory;
  artifactService?: ArtifactService;
  runLogService?: RunLogService;
  daemonLogger?: DaemonLogger;
  // existing fields...
}
```

Inside `createRunService`, resolve it once:

```ts
const daemonLogger = input.daemonLogger ?? noopDaemonLogger;
```

In `apps/daemon/src/index.ts`, pass the existing logger into run-service:

```ts
const runService = createRunService({
  config,
  persistence,
  artifactService,
  runLogService,
  daemonLogger,
  clock: options.clock,
});
```

In `apps/daemon/src/core/run-service.ts`, delete the old close block from its current position after `persistence.updateRunTerminal(...)`:

```ts
state.logHandle?.close();
state.logHandle = null;
```

Do not replace those two lines in place. Move log closing earlier: insert this block after artifact finalization has completed and immediately before the existing terminal event line:

```ts
emitRunEvent(state, { type: 'end', status: finalStatus });
```

Inserted block:

```ts
if (state.logHandle) {
  try {
    await state.logHandle.close();
  } catch (error) {
    daemonLogger.warn('run_log_write_failed', {
      error,
      runId: state.runId,
    });
    emitRunEvent(state, {
      type: 'warning',
      code: 'RUN_LOG_WRITE_FAILED',
      message: 'Run log write failed.',
    });
  } finally {
    state.logHandle = null;
  }
}
```

The resulting order inside `finishRun()` must be:

```ts
// 1. finalize artifacts and emit artifact_finalized events
// 2. close run logs and emit warning if close fails
// 3. emit terminal end event
// 4. accumulator.flushTerminal(...)
// 5. persistence.updateRunTerminal(...)
```

Then keep the terminal event and persistence flow as before:

```ts
emitRunEvent(state, { type: 'end', status: finalStatus });
```

This order preserves artifact-first behavior, makes the warning visible to durable message history through the existing terminal accumulator flush, and keeps the final `lastRunEventId` pointing at the `end` event. Do not let log write failure change the run terminal status.

- [ ] **Step 7: Add a durable warning regression test**

In `apps/daemon/tests/core/run-service.test.ts`, extend the local `setup` helper so individual tests can inject a fake run log service and daemon logger:

```ts
import type { DaemonLogger } from '../../src/core/daemon-logger.js';
import type { RunLogService } from '../../src/core/run-log-service.js';

function setup(
  options: {
    capabilities?: Parameters<RunServiceRunnerFactory>[0]['capabilities'];
    configure?: (config: DaemonConfig) => void;
    runLogService?: RunLogService;
    daemonLogger?: DaemonLogger;
  } = {},
) {
  // existing setup...
  const service = createRunService({
    config,
    persistence,
    runnerFactory,
    runLogService: options.runLogService,
    daemonLogger: options.daemonLogger,
    capabilityProbe: async () => options.capabilities ?? {},
    timer: timerHarness.timer,
    clock: () => 5000,
    eventBufferTtlMs: 1000,
    ids: {
      // existing ids...
    },
  });
  // existing return...
}
```

Add this test near the existing artifact-before-terminal test:

```ts
it('persists run log close warning before terminal end without changing final status', async () => {
  const daemonLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => {}),
  };
  const closeError = new Error('disk full');
  const runLogService = {
    dataDir: '',
    openRunLogs: vi.fn(async () => ({
      stdout: vi.fn(),
      stderr: vi.fn(),
      debugEvent: vi.fn(),
      close: vi.fn(async () => {
        throw closeError;
      }),
    })),
    getRunLogs: vi.fn(),
    getRunLogDownload: vi.fn(),
    pruneExpiredLogs: vi.fn(),
  } satisfies RunLogService;
  const { root, config, db, workspace, workspaceCwd, service, runners, runNextTimer } = setup({
    daemonLogger,
    runLogService,
  });
  writeSkill(root);

  await service.createRun({
    client: config.clients[0]!,
    request: {
      profileId: 'report-docx',
      workspaceId: workspace.id,
      kind: 'generate',
      prompt: 'Write the report.',
      skillId: 'report-writer',
    },
  });
  await runScheduledStart(runNextTimer);
  await vi.waitFor(() => expect(runners).toHaveLength(1));
  writeFileSync(path.join(workspaceCwd, 'output', 'report.docx'), 'docx');

  runners[0]!.complete({
    status: 'succeeded',
    exitCode: 0,
    signal: null,
    stdoutTail: '',
    stderrTail: '',
  });
  await flushAsync();

  await vi.waitFor(() => {
    expect(getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' })?.run.status).toBe('succeeded');
  });
  const detail = getRunDetail(db, { runId: 'run_1', clientId: 'lqbot' });
  const events = detail?.messages[1]?.events as Array<{ type: string; code?: string }>;
  const eventTypes = events.map((event) => event.type);
  expect(eventTypes).toEqual(expect.arrayContaining(['artifact_finalized', 'warning', 'end']));
  expect(eventTypes.indexOf('artifact_finalized')).toBeLessThan(eventTypes.indexOf('warning'));
  expect(eventTypes.indexOf('warning')).toBeLessThan(eventTypes.indexOf('end'));
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'warning',
      code: 'RUN_LOG_WRITE_FAILED',
    }),
  );
  expect(daemonLogger.warn).toHaveBeenCalledWith('run_log_write_failed', {
    error: closeError,
    runId: 'run_1',
  });
});
```

This test must fail if the warning is emitted after `accumulator.flushTerminal(...)`, because `run_messages.events_json` will not contain `RUN_LOG_WRITE_FAILED`.

- [ ] **Step 8: Update tests to await close**

Replace every test call:

```ts
logs.close();
```

with:

```ts
await logs.close();
```

For inline expressions:

```ts
(await service.openRunLogs({ runId: 'run_1' })).close();
```

replace with:

```ts
await (await service.openRunLogs({ runId: 'run_1' })).close();
```

- [ ] **Step 9: Run log/review tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run \
  tests/core/run-log-service.test.ts \
  tests/http/logs-routes.test.ts \
  tests/core/review-bundle-service.test.ts \
  tests/http/review-bundle-routes.test.ts \
  tests/core/run-service.test.ts \
  tests/static/no-sync-runtime-io.test.ts
```

Expected: service/route tests PASS; static test still FAIL only for `review-bundle-service.ts` and `daemon-logger.ts` if those are not yet converted.

- [ ] **Step 10: Commit**

```bash
git add apps/daemon/src/core/run-log-service.ts apps/daemon/src/core/run-service.ts apps/daemon/src/core/run-events.ts apps/daemon/src/core/event-visibility.ts apps/daemon/src/index.ts apps/daemon/tests
git commit -m "refactor: make run log io async"
```

---

## Task 5: Async Review Bundle Log Reads

**Files:**
- Modify: `apps/daemon/src/core/review-bundle-service.ts`
- Test: `apps/daemon/tests/core/review-bundle-service.test.ts`
- Test: `apps/daemon/tests/http/review-bundle-routes.test.ts`

- [ ] **Step 1: Replace sync import**

Replace:

```ts
import { readFileSync } from 'node:fs';
```

with:

```ts
import { readFile } from 'node:fs/promises';
```

- [ ] **Step 2: Await log file read**

Change:

```ts
content: sanitizeLogText(readFileSync(download.filePath, 'utf8')),
```

to:

```ts
content: sanitizeLogText(await readFile(download.filePath, 'utf8')),
```

- [ ] **Step 3: Run review bundle tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run \
  tests/core/review-bundle-service.test.ts \
  tests/http/review-bundle-routes.test.ts \
  tests/static/no-sync-runtime-io.test.ts
```

Expected: review bundle tests PASS; static test still FAIL only for `daemon-logger.ts` if it has not been converted.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/core/review-bundle-service.ts apps/daemon/tests/core/review-bundle-service.test.ts apps/daemon/tests/http/review-bundle-routes.test.ts
git commit -m "refactor: read review bundle logs asynchronously"
```

---

## Task 6: Async Queued Daemon Service Logger

**Files:**
- Modify: `apps/daemon/src/core/daemon-logger.ts`
- Modify: `apps/daemon/src/index.ts`
- Test: modify `apps/daemon/tests/core/daemon-logger.test.ts`
- Test: `apps/daemon/tests/http/app-logging.test.ts`
- Test: `apps/daemon/tests/index.test.ts`

- [ ] **Step 1: Expand logger interface**

Change:

```ts
export interface DaemonLogger {
  debug(event: string, data?: LogData): void;
  info(event: string, data?: LogData): void;
  warn(event: string, data?: LogData): void;
  error(event: string, data?: LogData): void;
}
```

to:

```ts
export interface DaemonLogger {
  debug(event: string, data?: LogData): void;
  info(event: string, data?: LogData): void;
  warn(event: string, data?: LogData): void;
  error(event: string, data?: LogData): void;
  flush(): Promise<void>;
}
```

Update `noopDaemonLogger` with:

```ts
flush: async () => {},
```

- [ ] **Step 2: Replace sync imports**

Replace:

```ts
import { appendFileSync, mkdirSync } from 'node:fs';
```

with:

```ts
import { appendFile, mkdir } from 'node:fs/promises';
```

- [ ] **Step 3: Implement queued async writes**

Use this structure:

```ts
export function createDaemonLogger(input: CreateDaemonLoggerInput): DaemonLogger {
  const now = input.now ?? Date.now;
  const logDir = path.join(input.dataDir, 'logs');
  const serviceLogPath = path.join(logDir, 'daemon.log');
  const errorLogPath = path.join(logDir, 'daemon-error.log');
  let queue = Promise.resolve();

  const enqueue = (level: LogLevel, event: string, data: LogData = {}) => {
    const line = JSON.stringify(createLogRecord({ data, event, level, time: now() })) + '\n';
    queue = queue
      .then(async () => {
        await mkdir(logDir, { recursive: true });
        await appendFile(serviceLogPath, line, 'utf8');
        if (level === 'warn' || level === 'error') {
          await appendFile(errorLogPath, line, 'utf8');
        }
      })
      .catch((error) => {
        reportLogWriteFailure(error);
      });
  };

  return {
    debug: (event, data) => enqueue('debug', event, data),
    info: (event, data) => enqueue('info', event, data),
    warn: (event, data) => enqueue('warn', event, data),
    error: (event, data) => enqueue('error', event, data),
    flush: async () => {
      await queue;
    },
  };
}
```

Build `line` before enqueueing the async operation. This preserves event-time timestamps and snapshots/redacts the `data` object immediately, matching the old synchronous logger semantics even when the caller mutates the object later.

- [ ] **Step 4: Await logger flush during shutdown**

In `installShutdownHandlers`, after:

```ts
context.daemonLogger?.info('daemon_shutdown_complete');
```

add:

```ts
await context.daemonLogger?.flush();
```

In `startServer`, best-effort flush after server-level errors because that path can precede process shutdown:

```ts
server.on('error', (error) => {
  context.daemonLogger.error('daemon_server_error', { error });
  void context.daemonLogger.flush().catch(() => {});
});
```

In the top-level entrypoint, keep the existing `console.error` fallback. If `main()` is refactored during implementation so a `DaemonLogger` exists before the failure is thrown, flush that logger before setting `process.exitCode = 1`. Do not block every production log line on `flush()`.

- [ ] **Step 5: Migrate existing logger tests**

`apps/daemon/tests/core/daemon-logger.test.ts` already exists and currently assumes synchronous writes. Update the existing tests instead of replacing them.

```ts
it('writes service info events to daemon.log as JSON lines', async () => {
  const dataDir = makeDataDir();
  const logger = createDaemonLogger({ dataDir, now: () => 1770000000000 });

  logger.info('daemon_started', { profileCount: 1 });
  await logger.flush();

  expect(readJsonLines(path.join(dataDir, 'logs', 'daemon.log'))).toEqual([
    {
      event: 'daemon_started',
      level: 'info',
      profileCount: 1,
      time: 1770000000000,
    },
  ]);
});
```

Apply the same pattern to the other existing tests:

```ts
logger.warn('queue_delay', { runId: 'run_1' });
logger.error('http_error', { error: new Error('download failed'), path: '/api/runs/run_1/artifacts/a/download' });
await logger.flush();

const serviceLines = readJsonLines(path.join(dataDir, 'logs', 'daemon.log'));
const errorLines = readJsonLines(path.join(dataDir, 'logs', 'daemon-error.log'));
```

For redaction:

```ts
logger.info('request_received', {
  apiKey: 'secret-api-key',
  authorization: 'Bearer secret-token',
  nested: { token: 'secret-token', safe: 'value' },
});
await logger.flush();

const text = readFileSync(path.join(dataDir, 'logs', 'daemon.log'), 'utf8');
```

For write failures:

```ts
expect(() => logger.error('http_error', { error: new Error('download failed') })).not.toThrow();
await logger.flush();
expect(consoleError).toHaveBeenCalledWith('Failed to write daemon service log:', expect.any(String));
```

Also add a regression test proving data is snapshotted at enqueue time:

```ts
it('snapshots log data and timestamp when the log call is made', async () => {
  let currentTime = 1;
  const dataDir = makeDataDir();
  const logger = createDaemonLogger({ dataDir, now: () => currentTime });
  const data = { value: 'before' };

  logger.info('event', data);
  currentTime = 2;
  data.value = 'after';
  await logger.flush();

  expect(readJsonLines(path.join(dataDir, 'logs', 'daemon.log'))).toEqual([
    expect.objectContaining({ event: 'event', time: 1, value: 'before' }),
  ]);
});
```

In `apps/daemon/tests/http/app-logging.test.ts`, update the in-memory test logger to satisfy the required interface:

```ts
logger: {
  debug: (event: string, data: Record<string, unknown> = {}) => records.push({ level: 'debug', event, data }),
  info: (event: string, data: Record<string, unknown> = {}) => records.push({ level: 'info', event, data }),
  warn: (event: string, data: Record<string, unknown> = {}) => records.push({ level: 'warn', event, data }),
  error: (event: string, data: Record<string, unknown> = {}) => records.push({ level: 'error', event, data }),
  flush: async () => {},
},
```

- [ ] **Step 6: Run logger tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run \
  tests/core/daemon-logger.test.ts \
  tests/http/app-logging.test.ts \
  tests/index.test.ts \
  tests/static/no-sync-runtime-io.test.ts
```

Expected: all listed tests PASS, including static guard.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/core/daemon-logger.ts apps/daemon/src/index.ts apps/daemon/tests/core/daemon-logger.test.ts apps/daemon/tests/http/app-logging.test.ts apps/daemon/tests/index.test.ts
git commit -m "refactor: make daemon service logging async"
```

---

## Task 7: Final Verification And Documentation

**Files:**
- Modify: `docs/postgres-persistence-migration/operator-runbook.md`
- Modify: `docs/claude-code-runner-daemon-version-roadmap.md`

- [ ] **Step 1: Add runbook note**

Append to `docs/postgres-persistence-migration/operator-runbook.md`:

```md
## Runtime I/O Note

After the PostgreSQL runtime migration, daemon database operations and runtime filesystem operations are asynchronous. Migration tools may still use synchronous SQLite/file helpers because they are offline operator commands, not request-serving daemon paths.
```

- [ ] **Step 2: Run static search**

Run:

```bash
rg "\\b\\w+Sync\\b|better-sqlite3|from 'node:fs'" apps/daemon/src/core apps/daemon/src/http apps/daemon/src/index.ts -n
```

Expected: only allowed `createReadStream` imports remain in artifact/log download routes and artifact scanner; no `*Sync` calls remain in runtime paths.

`apps/daemon/src/core/skill-registry.ts` may still appear if it has a type-only import such as:

```ts
import type { Dirent } from 'node:fs';
```

That is allowed because it is erased at runtime and the static guard intentionally permits it.

- [ ] **Step 3: Run targeted daemon tests**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run \
  tests/static/no-sync-runtime-io.test.ts \
  tests/core/workspace-service.test.ts \
  tests/http/workspaces-routes.test.ts \
  tests/http/workspace-files-routes.test.ts \
  tests/core/run-log-service.test.ts \
  tests/http/logs-routes.test.ts \
  tests/core/review-bundle-service.test.ts \
  tests/http/review-bundle-routes.test.ts \
  tests/core/daemon-logger.test.ts \
  tests/http/app-logging.test.ts \
  tests/index.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm typecheck
pnpm build
pnpm test:daemon
```

Expected: all PASS. `pnpm test:daemon` may skip PG-gated tests locally when `CLAUDE_RUNNER_TEST_PG_URL` is absent.

If `CLAUDE_RUNNER_TEST_PG_URL` is available, also run:

```bash
set -a
. ../../.env
set +a
pnpm exec vitest run
```

from `apps/daemon`.

Expected: all daemon tests PASS, including PG-gated tests.

Final acceptance requires one PG-enabled run before merging this branch. Local runs without `CLAUDE_RUNNER_TEST_PG_URL` are useful for iteration but are not sufficient to prove the startup prune wiring in `apps/daemon/src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add docs/postgres-persistence-migration/operator-runbook.md docs/claude-code-runner-daemon-version-roadmap.md apps/daemon/tests/static/no-sync-runtime-io.test.ts
git commit -m "docs: document async runtime io boundary"
```

---

## Risks And Guardrails

- **Log ordering:** Run log writes must be queued per file. Do not write chunks in parallel or stdout/stderr files can get reordered internally.
- **Log durability:** `RunLogHandle.close()` must flush queued writes. `finishRun()` must await it or terminal runs may expose incomplete logs.
- **Log close observability:** Log close failures must be persisted through `daemonLogger.warn('run_log_write_failed', ...)` and represented as a durable `warning` run event before the terminal `end` event.
- **Runner callbacks:** Do not make `stdout/stderr/debugEvent` async unless `cli-runner` and `CliRunnerLogSink` are redesigned to await backpressure. For this plan, callbacks enqueue and return immediately.
- **Terminal semantics:** Do not move `updateRunTerminal` before artifact finalization. Artifact-first terminal behavior is preserved from the PG migration plan.
- **Temp cleanup:** Best-effort cleanup after response settlement may use `void promise.catch(...)`; request-critical cleanup must be awaited.
- **Daemon logger timestamps:** Build daemon log lines at enqueue time, not flush time, so timestamps and redacted data match the original event.
- **Fatal-process logging:** This plan flushes daemon logs on graceful shutdown and server-level errors. It does not add a full `uncaughtException`/`unhandledRejection` crash manager; that remains a known tradeoff unless a later reliability plan adds one.
- **Workspace copy concurrency:** `prepareWorkspaceFiles` may copy different target files concurrently after duplicate target paths are rejected. This plan does not add a concurrency limiter; add one later if very large attachment batches become a file-descriptor pressure source.
- **Static guard:** Keep the guard focused on runtime source paths. Do not make migration/test/startup config code satisfy daemon runtime constraints unless a separate plan expands scope. The guard is text-based and may fail on comments or strings containing `*Sync`; reword those rather than weakening the guard.

## Self-Review Checklist

- [ ] Every runtime sync filesystem point identified in the audit maps to a task.
- [ ] PostgreSQL persistence is not modified by this plan.
- [ ] Migration tools remain out of scope.
- [ ] Public API response shapes remain unchanged.
- [ ] `RunLogHandle.close()` async signature has all call sites updated.
- [ ] `RunEvent` and `eventVisibilityByType` include the new `warning` type.
- [ ] `createRunService` receives `daemonLogger` from `index.ts`.
- [ ] Run log close failure has a test proving `RUN_LOG_WRITE_FAILED` is persisted before terminal `end`.
- [ ] Upload temp service tests await async service methods.
- [ ] Existing daemon logger tests await `logger.flush()`.
- [ ] In-memory test loggers implement `flush()`.
- [ ] Static guard prevents future `*Sync` calls in daemon runtime paths.
- [ ] Full verification includes typecheck, build, daemon tests, and PG-gated daemon tests when available.

# Phase 4 Input Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daemon-owned workspace upload path so trusted callers can send files directly to the daemon and place them in a workspace without relying on shared local `allowedInputRoots`.

**Architecture:** Phase 4 adds a narrow multipart upload API under `/api/workspaces/:workspaceId/files`. The HTTP route streams one uploaded file into a daemon-controlled temporary directory under `server.dataDir`, then core workspace logic copies it into a safe workspace-relative target path using the same path-safety rules as `prepare`. Temporary upload files are deleted after each request and pruned on startup; no durable upload table is added.

**Tech Stack:** TypeScript ESM, Express 5, multer disk storage, Node.js fs/path, zod, better-sqlite3 repositories for workspace authorization, Vitest.

---

## Current Baseline

`main` after Phase 3 provides:

- `POST /api/workspaces` to create or get a workspace.
- `POST /api/workspaces/:workspaceId/prepare` to copy files from daemon-local `profile.allowedInputRoots` into a workspace.
- Safe workspace path validation through `assertWorkspaceRelativePath()`.
- Workspace skeleton creation under profile `sandboxRoot`.
- API key auth, client/profile authorization, admin-aware workspace lookup.
- Queue, run timeout, run logs, artifact scan/list/download, and graceful shutdown.

Current limitation:

- A caller can only prepare input files that already exist on the daemon host under a configured `allowedInputRoots` path.
- The design document explicitly defers a daemon upload API for cases where the business system and daemon do not share a filesystem.

Phase 4 intentionally addresses only the first daemon upload slice. It does not add remote URL pull or object storage pull.

## Source-Of-Truth Planning Notes

This phase follows the "second version" direction in `/home/orangels/ls_dev/lance-agent-runner-daemon/docs/claude-code-runner-daemon-design.md`:

- Around line 361: upload API can be added later by uploading to daemon-accessible temp storage and then copying into the sandbox workspace.
- Around lines 1377-1383: second version can consider `POST /api/workspaces/:id/files`, remote URL pull, and S3/object storage pull.
- Around lines 224-241: security boundary remains directory isolation only, not a strong OS sandbox.

Phase 3 explicitly excluded upload/remote/S3 so the queue/log/hardening work could stay contained. Phase 4 is the next narrow cross-service boundary expansion.

## Non-Negotiable Boundaries

- Repository path is `/home/orangels/ls_dev/lance-agent-runner-daemon`.
- Keep this repository standalone; do not import from `/home/orangels/ls_dev/lanceDesign`.
- First version security posture still applies: trusted callers/profiles/deployments, directory isolation only.
- Do not claim the upload API creates a strong sandbox.
- Do not expose sandbox absolute paths, upload temp paths, `server.dataDir`, `sandboxRoot`, `allowedInputRoots`, `claudeConfigDir`, credentials, or raw multer file paths in API responses.
- Do not let upload requests override `claudeConfigDir`, `claudeBin`, `skillRoots`, `allowedInputRoots`, `permissionMode`, env, artifact rules, queue limits, or timeout values.
- Do not pass upload temp directories or complete `allowedInputRoots` to Claude Code `--add-dir`.
- Do not add a `run_events` table.
- Do not add a durable uploads table in Phase 4.
- Do not add remote URL pull, S3/object-storage pull, signed URLs, browser direct CORS, user-level browser auth, profile hot reload, metrics, OS-level isolation, separate uid execution, containers, seccomp/firejail, or Claude permission hooks.
- Do not change existing `POST /api/workspaces/:workspaceId/prepare` behavior except sharing safe copy helpers.
- Keep `.claude-runner-skills/` protected from uploaded targets.

## Phase 4 Minimal Runnable Target

Phase 4 is complete when this flow works:

1. A trusted client creates or gets a workspace with `POST /api/workspaces`.
2. The client uploads one file with `POST /api/workspaces/:workspaceId/files` using `multipart/form-data`.
3. The upload request contains:
   - field `file`: exactly one file;
   - field `targetPath`: workspace-relative path such as `input/source.docx`.
4. The daemon writes the incoming file to `server.dataDir/uploads/tmp/...`.
5. After multer finishes, the daemon validates the workspace, client access, profile access, temp path containment, and `targetPath`.
6. The daemon copies the temp file into the workspace target path.
7. The daemon deletes the temp file and its per-upload temp directory in success and failure paths.
8. The response contains only public workspace data and file metadata:

```json
{
  "workspaceId": "ws_123",
  "workspaceKey": "lqbot/user_1/project_123",
  "file": {
    "targetPath": "input/source.docx",
    "size": 123456,
    "originalName": "source.docx",
    "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }
}
```

9. Oversized uploads return HTTP `413` with structured `BAD_REQUEST` and no temp path leakage.
10. Missing file, duplicate file fields, unsafe `targetPath`, protected skill directory targets, and cross-client workspace access fail with structured errors.
11. Startup prunes stale temp upload directories under `server.dataDir/uploads/tmp` without touching workspaces, artifacts, logs, or messages.

## API Contract

Add:

```text
POST /api/workspaces/:workspaceId/files
Content-Type: multipart/form-data
Authorization: Bearer <api-key>
```

Multipart fields:

```text
file        required, exactly one binary file
targetPath  required text field, workspace-relative, same safety rules as prepare targetPath
```

Response status:

```text
200 OK
```

Response body:

```ts
interface UploadWorkspaceFileResponse {
  workspaceId: string;
  workspaceKey: string;
  file: {
    targetPath: string;
    size: number;
    originalName: string;
    mimeType: string | null;
  };
}
```

Error mapping:

- Missing auth: existing `401 UNAUTHORIZED`.
- Workspace not found or another client's workspace: existing `404 NOT_FOUND`.
- Client lacks profile access: existing `403 PROFILE_NOT_ALLOWED`.
- Missing `file`: `400 BAD_REQUEST`.
- More than one file or wrong file field: `400 BAD_REQUEST`.
- Oversized upload: HTTP `413`, error code `BAD_REQUEST`, message `"Uploaded file is too large"`.
- Unsafe `targetPath`: existing `400 PATH_NOT_ALLOWED`.
- Unexpected multer/storage failure: existing `500 INTERNAL_ERROR`, with sanitized generic message.

No new public API returns upload temp ids, temp file paths, absolute workspace paths, or source paths.

## Module Map And Dependencies

Create these modules:

- `src/core/upload-temp-service.ts`
  - Owns upload temp root calculation under `server.dataDir/uploads/tmp`.
  - Allocates per-upload temp directories.
  - Validates that multer-produced temp paths stay under the temp root.
  - Deletes per-upload temp files/directories.
  - Prunes stale temp upload directories on startup.
  - No Express or multer dependency.
- `src/http/workspace-files-routes.ts`
  - Owns `POST /api/workspaces/:workspaceId/files`.
  - Uses auth middleware, multer, validation schema, `WorkspaceService`, and `UploadTempService`.
  - Converts multer errors into daemon errors.

Modify these modules:

- `src/config/profiles.ts`
  - Add `server.maxUploadBytesPerFile` default.
  - Add `server.uploadTempRetentionMs` default.
  - Keep existing config files backwards compatible.
- `src/core/run-types.ts`
  - Add `UploadWorkspaceFileResponse` and uploaded file metadata types.
- `src/http/validation.ts`
  - Add `workspaceUploadFieldsSchema` for multipart text fields.
  - Reuse the existing workspace-relative path rules.
- `src/core/workspace-service.ts`
  - Extract a small private helper for copying a source file into a workspace target.
  - Add `prepareUploadedWorkspaceFile()` that copies a daemon-owned temp file into a workspace without requiring `allowedInputRoots`.
  - Keep `prepareWorkspaceFiles()` behavior unchanged.
- `src/http/app.ts`
  - Wire the workspace files route under `/api/workspaces` before or alongside the existing workspaces router.
- `src/index.ts`
  - Construct `uploadTempService`.
  - Call startup pruning once after config/db/service wiring and before accepting traffic.
  - Pass `uploadTempService` to `createApp()`.

Tests to create:

- `src/core/__tests__/upload-temp-service.test.ts`
- `src/http/__tests__/workspace-files-routes.test.ts`

Tests to modify:

- `src/config/__tests__/profiles.test.ts`
- `src/http/__tests__/validation.test.ts`
- `src/core/__tests__/workspace-service.test.ts`
- `src/__tests__/index.test.ts`

Dependency direction:

```text
index.ts
  -> config, db, workspace service, upload temp service, other core services, http app

http/workspace-files-routes.ts
  -> auth middleware, validation, upload temp service, workspace service, db workspace lookup

core/workspace-service.ts
  -> path-safety, db repositories, fs/path

core/upload-temp-service.ts
  -> config types, path-safety, fs/path

config/profiles.ts
  -> zod only
```

`src/core/*` must not import Express or multer.

## Implementation Sequence

### Task 1: Config And Upload Contract

**Files:**

- Modify: `src/config/profiles.ts`
- Modify: `src/core/run-types.ts`
- Modify: `src/http/validation.ts`
- Test: `src/config/__tests__/profiles.test.ts`
- Test: `src/http/__tests__/validation.test.ts`

- [ ] Add upload config fields to `ServerConfig`:

```ts
export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  globalConcurrency: number;
  maxQueueSize: number;
  logRetentionMs: number;
  maxLogBytesPerRun: number;
  maxUploadBytesPerFile: number;
  uploadTempRetentionMs: number;
}
```

- [ ] Add defaults to `serverSchema`:

```ts
maxUploadBytesPerFile: z.number().int().min(1).default(50 * 1024 * 1024),
uploadTempRetentionMs: z.number().int().min(0).default(24 * 60 * 60 * 1000),
```

- [ ] Write config tests:
  - existing minimal config parses without upload fields and receives defaults;
  - explicit positive values are accepted;
  - `maxUploadBytesPerFile=0` is rejected;
  - `uploadTempRetentionMs=-1` is rejected.

- [ ] Add response types to `src/core/run-types.ts`:

```ts
export interface UploadedWorkspaceFile {
  targetPath: string;
  size: number;
  originalName: string;
  mimeType: string | null;
}

export interface UploadWorkspaceFileResponse {
  workspaceId: string;
  workspaceKey: string;
  file: UploadedWorkspaceFile;
}
```

- [ ] Add multipart field validation to `src/http/validation.ts`:

```ts
export const workspaceUploadFieldsSchema = z
  .object({
    targetPath: workspaceRelativePathSchema,
  })
  .strict();
```

- [ ] Write validation tests:
  - accepts `{ targetPath: 'input/source.docx' }`;
  - rejects absolute `targetPath`;
  - rejects `../source.docx`;
  - rejects `.claude-runner-skills/source.docx`;
  - maps upload `targetPath` errors to `PATH_NOT_ALLOWED`.

- [ ] Run:

```bash
pnpm test src/config/__tests__/profiles.test.ts src/http/__tests__/validation.test.ts
pnpm typecheck
```

Expected: targeted tests and typecheck pass.

- [ ] Commit:

```bash
git add src/config/profiles.ts src/core/run-types.ts src/http/validation.ts src/config/__tests__/profiles.test.ts src/http/__tests__/validation.test.ts
git commit -m "chore: define phase 4 upload contract"
```

### Task 2: Upload Temp Service

**Files:**

- Create: `src/core/upload-temp-service.ts`
- Test: `src/core/__tests__/upload-temp-service.test.ts`

- [ ] Implement `UploadTempService`:

```ts
export interface UploadTempService {
  getTempRoot(): string;
  createUploadDirectory(): string;
  assertTempPath(filePath: string): string;
  removeUploadPath(filePath: string): void;
  pruneExpiredUploads(input?: { now?: number }): { removed: number };
}
```

- [ ] Implementation requirements:
  - temp root is `path.join(config.server.dataDir, 'uploads', 'tmp')`;
  - `createUploadDirectory()` creates a unique child directory under temp root;
  - use existing `createId('upload')` or a collision-resistant equivalent;
  - `assertTempPath()` resolves the path and verifies it stays under temp root with `isPathInsideRoot()`;
  - `removeUploadPath()` removes the file and then removes its immediate parent directory if that parent is under temp root and empty;
  - `pruneExpiredUploads()` removes only child directories under temp root whose mtime is older than `server.uploadTempRetentionMs`;
  - if retention is `0`, pruning may remove every stale child directory under temp root;
  - never remove `server.dataDir`, `uploads/`, the temp root itself, workspaces, artifacts, logs, or message data.

- [ ] Write tests:
  - creates temp root and one unique upload directory;
  - `assertTempPath()` accepts a file under the upload directory;
  - `assertTempPath()` rejects sibling-prefix escapes;
  - `removeUploadPath()` deletes the file and empty per-upload directory;
  - `pruneExpiredUploads()` removes old temp child directories;
  - `pruneExpiredUploads()` leaves fresh child directories intact;
  - `pruneExpiredUploads()` does not remove the temp root itself.

- [ ] Run:

```bash
pnpm test src/core/__tests__/upload-temp-service.test.ts
pnpm typecheck
```

Expected: upload temp service tests and typecheck pass.

- [ ] Commit:

```bash
git add src/core/upload-temp-service.ts src/core/__tests__/upload-temp-service.test.ts
git commit -m "feat: add upload temp service"
```

### Task 3: Workspace Uploaded File Import

**Files:**

- Modify: `src/core/workspace-service.ts`
- Test: `src/core/__tests__/workspace-service.test.ts`

- [ ] Extend `WorkspaceService`:

```ts
export interface WorkspaceService {
  createOrGetWorkspace(input: CreateOrGetWorkspaceInput): PublicWorkspace;
  prepareWorkspaceFiles(input: PrepareWorkspaceFilesInput): PreparedWorkspaceFiles;
  prepareUploadedWorkspaceFile(input: PrepareUploadedWorkspaceFileInput): UploadedWorkspaceFileResult;
}
```

- [ ] Add input/result types:

```ts
interface PrepareUploadedWorkspaceFileInput {
  clientId: string;
  isAdmin?: boolean;
  profile: ProfileConfig;
  workspaceId: string;
  sourcePath: string;
  targetPath: string;
  originalName: string;
  mimeType: string | null;
}

export interface UploadedWorkspaceFileResult extends PublicWorkspace {
  file: {
    targetPath: string;
    size: number;
    originalName: string;
    mimeType: string | null;
  };
}
```

- [ ] Extract private helper from `prepareWorkspaceFiles()`:

```ts
function copyFileIntoWorkspace(input: {
  workspaceCwd: string;
  sourcePath: string;
  targetPath: string;
}): PreparedWorkspaceFile {
  const targetPath = assertWorkspaceRelativePath(input.targetPath);
  const targetAbsolutePath = resolveUnderRoot(input.workspaceCwd, targetPath);
  mkdirSync(path.dirname(targetAbsolutePath), { recursive: true });
  copyFileSync(input.sourcePath, targetAbsolutePath);
  const size = statSync(targetAbsolutePath).size;
  return { targetPath, size };
}
```

- [ ] Keep `prepareWorkspaceFiles()` source validation unchanged:

```ts
const sourcePath = resolveAllowedSourcePath(input.profile.allowedInputRoots, file.sourcePath);
return copyFileIntoWorkspace({ workspaceCwd: cwd, sourcePath, targetPath: file.targetPath });
```

- [ ] Implement `prepareUploadedWorkspaceFile()`:
  - read workspace through `getWorkspaceForClient()`;
  - return `NOT_FOUND` if the workspace is unavailable to the client;
  - use `getWorkspaceCwd(profile, workspace)`;
  - copy the daemon-owned temp `sourcePath` into `targetPath`;
  - return public workspace data plus uploaded file metadata;
  - do not check `profile.allowedInputRoots`, because this path was created by the daemon upload temp service;
  - do not expose absolute source or target paths.

- [ ] Write tests:
  - copies a daemon temp file to `input/upload.docx`;
  - response contains `workspaceId`, `workspaceKey`, `targetPath`, `size`, `originalName`, and `mimeType`;
  - response does not contain temp path, workspace absolute path, `sandboxRoot`, or `allowedInputRoots`;
  - rejects `.claude-runner-skills/upload.docx`;
  - another client cannot import into this workspace;
  - existing `prepareWorkspaceFiles()` tests still prove `allowedInputRoots` checks for sourcePath.

- [ ] Run:

```bash
pnpm test src/core/__tests__/workspace-service.test.ts
pnpm typecheck
```

Expected: workspace service tests and typecheck pass.

- [ ] Commit:

```bash
git add src/core/workspace-service.ts src/core/__tests__/workspace-service.test.ts
git commit -m "feat: import uploaded files into workspaces"
```

### Task 4: Workspace Files HTTP Route

**Files:**

- Create: `src/http/workspace-files-routes.ts`
- Modify: `src/http/app.ts`
- Test: `src/http/__tests__/workspace-files-routes.test.ts`

- [ ] Create a route module:

```ts
export function createWorkspaceFilesRouter(dependencies: {
  config: DaemonConfig;
  db: RunnerDatabase;
  workspaceService: WorkspaceService;
  uploadTempService: UploadTempService;
}): Router;
```

- [ ] Use multer disk storage:
  - destination is `uploadTempService.createUploadDirectory()`;
  - filename is a safe internal filename such as `file`;
  - `limits.fileSize` is `config.server.maxUploadBytesPerFile`;
  - `limits.files` is `1`;
  - accept only `.single('file')`.

- [ ] Route flow for `POST /api/workspaces/:workspaceId/files`:
  1. authenticate with existing `requireAuth(config)`;
  2. run multer `.single('file')`;
  3. parse `request.body` with `workspaceUploadFieldsSchema`;
  4. require `request.file`;
  5. verify workspace with `getWorkspaceForClient(db, { workspaceId, clientId, isAdmin })`;
  6. require profile access for the workspace profile;
  7. load profile with `getProfile(config, workspace.profileId)`;
  8. call `uploadTempService.assertTempPath(request.file.path)`;
  9. call `workspaceService.prepareUploadedWorkspaceFile()`;
  10. delete temp path in `finally`;
  11. respond with the service result.

- [ ] Error handling:
  - `LIMIT_FILE_SIZE` -> `daemonError('BAD_REQUEST', 'Uploaded file is too large', 413)`;
  - `LIMIT_FILE_COUNT`, `LIMIT_UNEXPECTED_FILE`, or duplicate file fields -> `badRequest('Expected exactly one file field named file')`;
  - missing file -> `badRequest('Missing upload file')`;
  - validation errors route through existing zod error mapping;
  - unexpected filesystem/multer errors route through app error handler as generic internal errors.

- [ ] Wire route in `src/http/app.ts`:

```ts
app.use(
  '/api/workspaces',
  createWorkspaceFilesRouter({
    config: dependencies.config,
    db: dependencies.db,
    workspaceService: dependencies.workspaceService,
    uploadTempService: dependencies.uploadTempService,
  }),
);
```

Mount it before the existing `createWorkspacesRouter()` call. The existing `POST /api/workspaces` and `POST /api/workspaces/:workspaceId/prepare` routes must continue working.

- [ ] Update `CreateAppDependencies` with `uploadTempService?: UploadTempService`. Keep it optional in tests that do not exercise uploads.

- [ ] Write route tests using real HTTP requests:
  - unauthenticated upload returns `401`;
  - authenticated upload writes `input/source.txt` and returns public metadata;
  - response does not contain sandbox absolute path or temp upload path;
  - missing `file` returns `400 BAD_REQUEST`;
  - missing `targetPath` returns `400`;
  - unsafe `targetPath` returns `400 PATH_NOT_ALLOWED`;
  - `.claude-runner-skills/source.txt` returns `400 PATH_NOT_ALLOWED`;
  - a second file field returns `400 BAD_REQUEST`;
  - file larger than `maxUploadBytesPerFile` returns HTTP `413` with `BAD_REQUEST`;
  - another client cannot upload into this workspace;
  - temp upload directory is removed after success;
  - temp upload directory is removed after service/validation failure.

- [ ] Run:

```bash
pnpm test src/http/__tests__/workspace-files-routes.test.ts src/http/__tests__/workspaces-routes.test.ts
pnpm typecheck
```

Expected: upload route tests, existing workspace route tests, and typecheck pass.

- [ ] Commit:

```bash
git add src/http/workspace-files-routes.ts src/http/app.ts src/http/__tests__/workspace-files-routes.test.ts
git commit -m "feat: add workspace file upload route"
```

### Task 5: Startup Pruning And Server Wiring

**Files:**

- Modify: `src/index.ts`
- Test: `src/__tests__/index.test.ts`

- [ ] Construct the upload temp service in `createServerContext()`:

```ts
const uploadTempService = createUploadTempService({ config, clock: options.clock });
uploadTempService.pruneExpiredUploads();
```

- [ ] Pass `uploadTempService` to `createApp()`.

- [ ] Extend `ServerContext`:

```ts
uploadTempService: UploadTempService;
```

- [ ] Write index tests:
  - `createServerContext()` exposes `uploadTempService`;
  - stale upload temp directories are pruned during context creation;
  - fresh upload temp directories are preserved;
  - importing `src/index.ts` still does not start the server;
  - existing Phase 3 graceful shutdown tests still pass.

- [ ] Run:

```bash
pnpm test src/__tests__/index.test.ts src/http/__tests__/workspace-files-routes.test.ts
pnpm typecheck
```

Expected: index/upload tests and typecheck pass.

- [ ] Commit:

```bash
git add src/index.ts src/__tests__/index.test.ts
git commit -m "feat: prune upload temp files on startup"
```

### Task 6: Integration And Scope Guards

**Files:**

- Modify tests only if gaps are found.
- Do not add new runtime scope in this task.

- [ ] Run targeted validation:

```bash
pnpm test src/config/__tests__/profiles.test.ts src/http/__tests__/validation.test.ts src/core/__tests__/upload-temp-service.test.ts src/core/__tests__/workspace-service.test.ts src/http/__tests__/workspace-files-routes.test.ts src/http/__tests__/workspaces-routes.test.ts src/__tests__/index.test.ts
```

Expected: all targeted tests pass.

- [ ] Run full validation:

```bash
pnpm typecheck
pnpm build
pnpm test
```

Expected: typecheck/build pass and all tests pass. The full test suite may need sandbox escalation because route tests open ephemeral local HTTP ports.

- [ ] Run response/path leak grep checks:

```bash
rg -n "file\\.path|destination|server\\.dataDir|sandboxRoot|allowedInputRoots|claudeConfigDir" src/http src/core
```

Expected:
  - route implementation may reference `request.file.path` internally;
  - no public response DTO includes temp paths or sandbox absolute paths;
  - existing config/profile internals may reference secret path fields, but route responses do not expose them.

- [ ] Run scope guard:

```bash
rg -n "run_events|chokidar|prom-client|undici|fetch\\(|S3|signed URL|metrics|seccomp|firejail|container|resume|fork" src
```

Expected:
  - existing dependencies/imports may appear only where they already existed before Phase 4;
  - no new runtime implementation for remote URL pull, S3, metrics, `run_events`, OS isolation, or Claude resume/fork.

- [ ] Run import guard:

```bash
rg -n "/home/orangels/ls_dev/lanceDesign|from ['\\\"].*lanceDesign|LANCE_DESIGN" src
```

Expected: no lanceDesign imports or product-specific runtime logic.

- [ ] Commit any final test-only or doc-only adjustments:

```bash
git add <changed-files>
git commit -m "test: cover phase 4 input ingestion"
```

Only commit if files changed in this task.

## Explicit Non-Goals For Phase 4

Do not implement:

- Remote URL pull.
- S3/object-storage pull.
- Upload manifests, durable upload ids, or an uploads SQLite table.
- Multi-file multipart upload in one request.
- Browser direct CORS, signed upload URLs, or signed download URLs.
- Workspace deletion API or workspace retention automation.
- Artifact watcher or running `artifact_candidate` events.
- Metrics endpoint or `prom-client` instrumentation.
- Persistent event replay from SQLite or a `run_events` table.
- Profile hot reload.
- Full distributed queue across multiple daemon processes.
- Recovery/resume of already-started Claude child processes after daemon restart.
- Claude Code native resume/fork.
- OS-level isolation, separate uid, containers, seccomp/firejail, or Claude permission hooks.
- Product-specific lanceDesign, lqBot, craft, critique, analytics, preview, deployment, tabs, routines, media, or live artifact MCP logic.

## Phase 4 Acceptance Criteria

- API:
  - `POST /api/workspaces/:workspaceId/files` exists and requires auth.
  - It accepts exactly one multipart file field named `file`.
  - It requires safe `targetPath`.
  - It returns public workspace/file metadata only.
- Security/path boundaries:
  - Uploaded files are first written under daemon `server.dataDir/uploads/tmp`.
  - Temp paths and sandbox absolute paths are never returned in API responses.
  - `.claude-runner-skills/` cannot be targeted.
  - Cross-client workspace upload is denied.
  - Upload temp roots are never passed to Claude Code `--add-dir`.
- Cleanup:
  - Temp files are removed after success.
  - Temp files are removed after validation/service failures.
  - Startup pruning removes stale temp upload directories only.
- Compatibility:
  - Existing `POST /api/workspaces/:workspaceId/prepare` behavior still works.
  - Existing Phase 3 queue/run/log/artifact tests still pass.
  - No schema migration is required.
- Scope:
  - No remote/S3/browser/signed URL/metrics/run_events/OS-isolation scope creep.

## Suggested Review Prompt

After implementation, ask CC or another reviewer:

```text
Please review the Phase 4 input ingestion implementation in:
/home/orangels/ls_dev/lance-agent-runner-daemon

Plan:
docs/phase-4-input-ingestion-plan.md

Focus areas:
- Does POST /api/workspaces/:workspaceId/files match the Phase 4 upload-only scope?
- Are temp upload paths contained under server.dataDir/uploads/tmp and cleaned on success/failure?
- Are workspace target paths validated with the same protections as prepare, especially .claude-runner-skills?
- Do responses avoid leaking temp paths, sandbox absolute paths, config paths, allowedInputRoots, or credentials?
- Does cross-client and profile authorization match existing workspace prepare behavior?
- Is multer error mapping structured and safe, especially oversized files?
- Does startup pruning touch only upload temp directories?
- Is there scope creep: remote URL pull, S3, signed URLs, CORS, metrics, run_events, OS isolation, resume/fork, or product-specific logic?
```

## Plan Self-Review

- Spec coverage: This plan covers the documented second-version upload API direction and deliberately leaves remote URL pull/S3 for later.
- Placeholder scan: The plan contains concrete file paths, commands, and expected outcomes for each task.
- Type consistency: Upload response/config/type names are introduced before use.
- Scope check: Single-file upload is the smallest useful ingestion slice; multi-file, remote, and object-storage ingestion can be separate future phases.

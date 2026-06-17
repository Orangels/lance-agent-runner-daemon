# Phase 2 Skill and Artifact Implementation Plan

> Historical plan note: this phase plan records the original SQLite-based implementation path. The current daemon runtime is PostgreSQL-only; SQLite remains only as a read-only migration source and historical backup format.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the first useful `kind=generate` flow by resolving a profile-allowed skill, staging its side files into the workspace, composing the skill prompt, scanning terminal artifacts, and exposing artifact list/download APIs.

**Architecture:** Phase 2 builds on the Phase 0/1 daemon foundation without changing the service boundary: HTTP routes stay thin, core modules own skill/artifact domain behavior, DB modules own SQLite persistence, and config remains the only source of skill roots and artifact rules. lanceDesign is a reference implementation only; port the behavior patterns for skill scanning/staging and file listing, but do not import or depend on lanceDesign private source.

**Tech Stack:** TypeScript ESM, Node.js fs/path/crypto streams, Express 5, better-sqlite3, zod, fast-glob, Vitest, Claude Code CLI stream-json.

---

## Current Baseline

Phase 1 already provides:

- `POST /api/runs` for durable `revise` runs.
- `runs` queued insert, user/assistant `run_messages`, sanitized `profile_snapshots`, SSE, cancel, and daemon-side message persistence.
- Claude Code spawn, stream parsing, capability probing, inactivity watchdog, and terminal status persistence.
- SQLite `artifacts` table schema, but no repository/API/scanner behavior.
- Config fields for `profile.skillRoots`, `allowedSkillIds`, `artifactRules`, and `defaultArtifactRuleIds`, but no runtime use of skill roots or artifact scan.

Phase 2 must remove the Phase 1 service-level rejection for `kind=generate`, but only after skill validation and staging exist.

## Non-Negotiable Boundaries

- This repository remains a standalone daemon at `/home/orangels/ls_dev/lance-agent-runner-daemon`.
- Reference repo is `/home/orangels/ls_dev/lanceDesign`; never import from it.
- `lanceDesign` product logic is out of scope: design systems, craft, memory, critique, analytics, live artifact MCP, deployments, tabs, routines/orbit, media tasks, tool tokens, local-client runtime, and `LANCE_DESIGN_*`.
- First version remains directory isolation only. Do not add OS isolation, separate uid execution, containers, seccomp/firejail, or permission hooks.
- `POST /api/runs` still references only `workspaceId`; do not reintroduce inline `originId/userId/projectId`.
- Requests must not override `claudeConfigDir`, `claudeBin`, `skillRoots`, `allowedInputRoots`, `permissionMode`, artifact glob patterns, or env.
- Do not add a `run_events` table.
- Do not use artifact watchers. Terminal glob scan is the authority for Phase 2.
- Do not implement upload API, remote URL pull, S3/object storage pull, browser direct CORS, signed URLs, metrics exposure, full queue scheduler, log route, or retention jobs.
- Do not pass `profile.allowedInputRoots` to Claude Code `--add-dir`.
- Do not pass whole `profile.skillRoots` to Claude Code `--add-dir`.
- `--add-dir` may only include the staged active skill directory under the workspace, and only when capability probing does not report `addDir === false`.
- Synchronous request validation must reject caller/config selection errors before a queued run row is inserted. Asynchronous filesystem/runtime failures after queued insert must become durable failed runs.

## Reference Map

Read these local design sections before implementation:

- `/home/orangels/ls_dev/lance-agent-runner-daemon/docs/claude-code-runner-daemon-design.md`
  - Skill handling: lines around 365-433.
  - Artifact rules and terminal scan: lines around 635-669.
  - Artifact schema: lines around 907-940.
  - Artifact download: lines around 1093-1139.
  - Required artifact missing strategy: lines around 1414-1417.
  - Workspace layout: lines around 1460-1477.
- `/home/orangels/ls_dev/lance-agent-runner-daemon/docs/claude-code-runner-daemon-migration-assessment.md`
  - Skill registry/staging: lines around 162-200.
  - Artifact scan strategy: lines around 343-351.
  - Recommended Phase 2 scope: lines around 530-540.
- `/home/orangels/ls_dev/lance-agent-runner-daemon/REFERENCE.md`
  - Skill registry and staging reference paths.
  - Migration boundary and product logic exclusion list.

Study these lanceDesign files as references only:

- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/skills.ts`
  - `listSkills()`
  - `withSkillRootPreamble()` around line 388
  - `dirHasAttachments()`
  - `collectReferencedSideFiles()`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/cwd-aliases.ts`
  - `SKILLS_CWD_ALIAS = '.lancedesign-skills'`
  - `stageActiveSkill()`
  - copy-not-symlink rationale
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/server.ts`
  - `composeDaemonSystemPrompt()` around line 3139
  - `stageActiveSkill()` call around line 3691
  - `resolveChatExtraAllowedDirs()` around line 660
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runtimes/defs/claude.ts`
  - `--include-partial-messages`, `--add-dir`, `--model`, `--permission-mode` construction.
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/frontmatter.ts`
  - YAML subset parser shape. Port only the generic parser idea.
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/projects.ts`
  - File listing and coarse extension/mime ideas. Do not copy product artifact manifest logic.

## Phase 2 Minimal Runnable Target

The first Phase 2 implementation is complete when this flow works:

1. A profile defines `skillRoots`, `allowedSkillIds`, `artifactRules`, and `defaultArtifactRuleIds`.
2. `POST /api/workspaces` creates the workspace skeleton including `.claude-runner-skills/`.
3. `POST /api/workspaces/:workspaceId/prepare` copies input files into `input/`.
4. `POST /api/runs` with `kind: "generate"` and `skillId`:
   - validates the skill id against `profile.allowedSkillIds`;
   - inserts no run row if the skill id is not profile-allowed;
   - later resolves the skill files from `profile.skillRoots` during async start;
   - inserts the queued run, messages, and profile snapshot before spawning;
   - stages only the active skill with side files into `<workspace>/.claude-runner-skills/<folder>/`;
   - composes the prompt with the skill body and staged skill path guidance;
   - starts Claude Code in the workspace cwd.
5. When the run reaches terminal:
   - scans selected artifact rules relative to the workspace root;
   - writes found artifacts to SQLite;
   - emits `artifact_finalized` events for found artifacts;
   - fails a previously successful run with `ARTIFACT_REQUIRED_MISSING` if any selected required rule has no matches.
   - emits `end` only after artifact and error events;
   - force-flushes `run_messages` with the final status before DB terminal update.
6. `GET /api/runs/:runId/artifacts` returns public artifact metadata without sandbox absolute paths.
7. `GET /api/runs/:runId/artifacts/:artifactId/download` streams the file if the current client can read the run.

No real Claude Code binary is required for automated tests; use fake runners and temporary workspaces. Manual smoke with a real `claude` binary can be optional after tests pass.

## Module Map And Dependencies

Create these modules:

- `src/core/frontmatter.ts`
  - Generic YAML-frontmatter subset parser for `SKILL.md`.
  - No daemon config, DB, Express, or lanceDesign dependency.
- `src/core/skill-registry.ts`
  - Scans `profile.skillRoots`.
  - Resolves a profile-allowed skill by id.
  - Produces generic skill records: `id`, `name`, `description`, `body`, `dir`, `folderName`, `source`, `metadata`, `hasSideFiles`.
  - Strips product-specific `lancedesign` metadata from public/generic metadata.
  - Depends on `src/config/profiles.ts` types and `frontmatter.ts`.
- `src/core/skill-staging.ts`
  - Copies the active skill directory into `.claude-runner-skills/<folder>/`.
  - Uses copy, not symlink.
  - Dereferences source symlinks during copy.
  - Refuses unsafe folder names and non-directory source paths.
  - Depends on `path-safety.ts`, not Express.
- `src/core/prompt-composer.ts`
  - Composes `generate` prompt from skill body plus user prompt.
  - Adds staged skill root preamble using `.claude-runner-skills/<folder>/` and the staged absolute path under the workspace only when side files were staged.
  - Returns original prompt for `revise`.
  - Does not include lanceDesign product instructions.
- `src/core/artifact-scanner.ts`
  - Scans selected profile artifact rules with `fast-glob`.
  - Resolves matches under workspace root only.
  - Computes file name, size, mtime, sha256, mime type, role, and rule id.
  - Does not watch the filesystem.
- `src/core/artifact-service.ts`
  - Owns artifact finalization and read authorization helpers.
  - Calls `artifact-scanner.ts`, DB repositories, `getWorkspaceCwd()`, and `path-safety.ts`.
  - Returns absolute file paths only to internal callers such as download routes, never in public DTOs.
- `src/http/artifacts-routes.ts`
  - Express route layer for artifact list/download.
  - Uses auth middleware and artifact service only.
  - Streams downloads; does not read whole files into memory.

Modify these existing modules:

- `src/core/run-events.ts`
  - Add `artifact_finalized` event type with public artifact metadata only.
- `src/core/event-visibility.ts`
  - Treat `artifact_finalized` as `quiet`.
- `src/core/run-types.ts`
  - Add public artifact DTO types if useful.
  - Add `SKILL_UNAVAILABLE`, `SKILL_STAGING_FAILED`, and `ARTIFACT_SCAN_FAILED` error codes.
  - Do not add a `run_events` table or event-persistence DTO.
- `src/core/claude-adapter.ts`
  - Treat `extraAllowedDirs` as the complete extra allowlist.
  - Do not implicitly add `workspaceCwd` to `--add-dir`.
- `src/core/run-service.ts`
  - Resolve/validate skills and artifact rule ids on run create.
  - Allow `kind=generate`.
  - Stage active skill and compose prompt before spawning.
  - Pass only the staged skill directory to Claude `extraAllowedDirs`.
  - Finalize artifacts before terminal `end` event and DB terminal update.
- `src/db/repositories.ts`
  - Add artifact row type, mapper, insert/replace/list/get helpers.
- `src/http/app.ts`
  - Wire artifact routes under `/api/runs/:runId/artifacts` when run service/artifact service is present.
- `src/index.ts`
  - Construct `artifactService` and pass it into `createRunService()` and `createApp()`.

Tests to create:

- `src/core/__tests__/frontmatter.test.ts`
- `src/core/__tests__/skill-registry.test.ts`
- `src/core/__tests__/skill-staging.test.ts`
- `src/core/__tests__/prompt-composer.test.ts`
- `src/core/__tests__/artifact-scanner.test.ts`
- `src/core/__tests__/artifact-service.test.ts`
- `src/http/__tests__/artifacts-routes.test.ts`

Tests to modify:

- `src/core/__tests__/claude-adapter.test.ts`
- `src/core/__tests__/run-service.test.ts`
- `src/core/__tests__/run-events.test.ts`
- `src/core/__tests__/event-visibility.test.ts`
- `src/db/__tests__/repositories.test.ts`
- `src/http/__tests__/runs-routes.test.ts`
- `src/http/__tests__/validation.test.ts`
- `src/__tests__/index.test.ts`

Dependency direction:

```text
index.ts
  -> config, db, core services, http app

http/*
  -> auth middleware, core services, config types

core/run-service.ts
  -> skill registry/staging/prompt composer
  -> artifact service
  -> db repositories
  -> cli runner / claude adapter

core/artifact-service.ts
  -> artifact scanner
  -> db repositories
  -> workspace-service/path-safety

core/skill-*.ts and prompt-composer.ts
  -> config types and path helpers only

db/*
  -> no core runtime process modules
```

## Implementation Sequence

### Task 1: Generic Frontmatter Parser

**Files:**

- Create: `src/core/frontmatter.ts`
- Test: `src/core/__tests__/frontmatter.test.ts`

- [ ] Write tests for:
  - `SKILL.md` without frontmatter returns `{ data: {}, body: original }`.
  - scalar values, booleans, numbers, flat arrays, and block literals parse.
  - UTF-8 BOM is ignored.
  - malformed non-key lines are skipped rather than throwing for discovery.
- [ ] Port the generic subset behavior from `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/frontmatter.ts`.
- [ ] Keep the parser dependency-free and product-neutral.
- [ ] Run:

```bash
pnpm test -- src/core/__tests__/frontmatter.test.ts
```

Expected: frontmatter tests pass.

**Acceptance:** Skill parsing has a local generic parser and no lanceDesign import.

### Task 2: Skill Registry

**Files:**

- Create: `src/core/skill-registry.ts`
- Test: `src/core/__tests__/skill-registry.test.ts`

- [ ] Write tests for root scanning:
  - scans each `profile.skillRoots` directory for child directories containing `SKILL.md`;
  - unreadable or missing roots are skipped;
  - first root wins on duplicate skill ids;
  - returned `dir` is absolute;
  - `body` excludes YAML frontmatter.
- [ ] Write tests for generic metadata:
  - `id` uses frontmatter `id` when present;
  - fallback id uses frontmatter `name`, then folder name;
  - `name` and `description` are strings;
  - `metadata` excludes `lancedesign`, `craft`, `preview`, `design_system`, `critique`, and other product-only nested fields.
- [ ] Document in the test name or assertion comment that frontmatter `id` is a new daemon extension. lanceDesign uses `name` or folder name only; this daemon may accept `id` to make generic skill packages less UI-name-coupled.
- [ ] Write tests for side-file detection:
  - a directory containing only `SKILL.md` has `hasSideFiles: false`;
  - a directory containing `assets/`, `references/`, `scripts/`, or sibling text/code files has `hasSideFiles: true`.
- [ ] Write tests for profile authorization:
  - `resolveSkillForProfile(profile, "report-writer")` succeeds only when the id is in `profile.allowedSkillIds`;
  - disallowed id throws `SKILL_NOT_ALLOWED`;
  - allowed but missing id throws `SKILL_NOT_ALLOWED` without leaking root absolute paths in the message/details.
- [ ] Implement:
  - `SkillRecord`;
  - `listProfileSkills(profile: ProfileConfig): Promise<SkillRecord[]>`;
  - `resolveSkillForProfile(profile: ProfileConfig, skillId: string): Promise<SkillRecord>`.
- [ ] Keep `resolveSkillForProfile()` scoped to filesystem discovery only. `createRun()` should perform synchronous `allowedSkillIds` membership checks before queued insert; missing or unreadable skill files after a valid allowlist check are async runtime failures.
- [ ] Run:

```bash
pnpm test -- src/core/__tests__/skill-registry.test.ts
```

Expected: registry tests pass.

**Acceptance:** The daemon can resolve exactly one profile-allowed skill from config-owned roots, with no user/global skill lookup.

### Task 3: Skill Staging

**Files:**

- Create: `src/core/skill-staging.ts`
- Test: `src/core/__tests__/skill-staging.test.ts`

- [ ] Write tests that staging copies only the active skill directory into:

```text
<workspace>/.claude-runner-skills/<folder>/
```

- [ ] Write tests that the staged directory is a real copy:
  - no symlink is created for the top-level staged folder;
  - symlinks inside the source are dereferenced;
  - editing staged files does not mutate the source skill directory.
- [ ] Write tests that unsafe folder names are rejected:
  - empty;
  - `.`;
  - `..`;
  - names containing `/`, `\`, or null byte;
  - absolute paths.
- [ ] Write tests that a non-directory source fails without deleting unrelated workspace files.
- [ ] Implement:
  - `STAGED_SKILLS_DIR = ".claude-runner-skills"`;
  - `stageSkillIntoWorkspace({ workspaceCwd, skill, logger? })`;
  - result fields `relativeRoot`, `absoluteRoot`, `folderName`.
- [ ] Ensure the implementation replaces a stale per-skill staged copy before copying, matching lanceDesign's “fresh active skill per turn” behavior.
- [ ] Run:

```bash
pnpm test -- src/core/__tests__/skill-staging.test.ts
```

Expected: staging tests pass.

**Acceptance:** Active skill side files are available inside the workspace through a copy barrier.

### Task 4: Prompt Composer For Generate Runs

**Files:**

- Create: `src/core/prompt-composer.ts`
- Test: `src/core/__tests__/prompt-composer.test.ts`

- [ ] Write tests that `revise` prompt composition returns the user prompt unchanged.
- [ ] Write tests that `generate` prompt includes:
  - skill name/id;
  - skill description when present;
  - skill body;
  - staged relative root `.claude-runner-skills/<folder>/`;
  - staged absolute root under the workspace;
  - user request under a separate “User request” section.
- [ ] Write tests that `generate` prompt for a skill with no side files includes the skill body and user request, but omits staged path guidance.
- [ ] Write tests that product words such as `lanceDesign`, `design system`, `critique`, and `craft` are not injected by the composer unless they are literally present in the skill body authored by the skill.
- [ ] Implement:
  - `composeRunPrompt({ kind, userPrompt, skill?, stagedSkill? })`.
- [ ] Use lanceDesign `withSkillRootPreamble()` as behavioral inspiration, but adapt the absolute fallback to the staged workspace path, not the original profile skill root.
- [ ] Match lanceDesign's injection condition: add the preamble only when the skill has side files and staging produced a workspace copy.
- [ ] Run:

```bash
pnpm test -- src/core/__tests__/prompt-composer.test.ts
```

Expected: prompt composer tests pass.

**Acceptance:** Generate prompt is skill-driven and stage-aware without product-specific daemon instructions.

### Task 5: Claude Invocation Allowlist Tightening

**Files:**

- Modify: `src/core/claude-adapter.ts`
- Test: `src/core/__tests__/claude-adapter.test.ts`

- [ ] Update tests so `buildClaudeInvocation()`:
  - emits no `--add-dir` when `extraAllowedDirs` is empty;
  - emits `--add-dir <stagedSkillDir>` when `extraAllowedDirs` contains one staged skill directory and `capabilities.addDir !== false`;
  - does not implicitly include `workspaceCwd` in `--add-dir`;
  - omits `--add-dir` when `capabilities.addDir === false`;
  - never includes `allowedInputRoots` unless a caller explicitly passes them, which Phase 2 run-service tests must prove it does not.
- [ ] Implement the minimal adapter change: `extraAllowedDirs` is the complete extra allowlist.
- [ ] Run:

```bash
pnpm test -- src/core/__tests__/claude-adapter.test.ts
```

Expected: adapter tests pass.

**Acceptance:** Phase 2 cannot accidentally grant Claude Code access to upload/input roots through adapter defaults.

### Task 6: Artifact Scanner

**Files:**

- Create: `src/core/artifact-scanner.ts`
- Test: `src/core/__tests__/artifact-scanner.test.ts`

- [ ] Write tests for glob scanning:
  - pattern `output/**/*.docx` finds files under workspace `output/`;
  - results are sorted by relative path for deterministic tests;
  - multiple selected rules can match different files;
  - same rule/path is not duplicated.
- [ ] Write tests for safety:
  - absolute patterns are rejected;
  - patterns containing null bytes are rejected;
  - matched paths resolving outside the workspace are ignored/rejected;
  - `.claude-runner-skills/**` is not returned as an artifact even if a rule pattern matches it.
- [ ] Write tests for metadata:
  - `fileName`;
  - `relativePath`;
  - `size`;
  - `mtime`;
  - `sha256`;
  - simple MIME inference for common report/file types: `.docx`, `.xlsx`, `.pdf`, `.txt`, `.md`, `.json`, `.html`, `.csv`, and fallback `application/octet-stream`.
- [ ] Implement `scanArtifacts({ workspaceCwd, rules, now })` using `fast-glob` with `cwd: workspaceCwd`, `onlyFiles: true`, and no watcher.
- [ ] Run:

```bash
pnpm test -- src/core/__tests__/artifact-scanner.test.ts
```

Expected: scanner tests pass.

**Acceptance:** Terminal artifact detection is profile-rule based and workspace-confined.

### Task 7: Artifact Repositories

**Files:**

- Modify: `src/db/repositories.ts`
- Test: `src/db/__tests__/repositories.test.ts`

- [ ] Add `ArtifactRecord` type matching the existing `artifacts` table.
- [ ] Add repository helpers:
  - `replaceArtifactsForRun(db, { runId, workspaceId, artifacts, now })`;
  - `listArtifactsForRun(db, { runId, clientId, isAdmin })`;
  - `getArtifactForRunForClient(db, { runId, artifactId, clientId, isAdmin })`.
- [ ] Write tests that:
  - artifact rows insert and map JSON metadata;
  - `replaceArtifactsForRun` deletes stale rows for the run only;
  - list/get are scoped by run id and client id;
  - admin can read across clients;
  - public records contain `relativePath`, not absolute paths.
- [ ] Run:

```bash
pnpm test -- src/db/__tests__/repositories.test.ts
```

Expected: repository tests pass.

**Acceptance:** Artifacts are durable, queryable, and client-scoped.

### Task 8: Artifact Service

**Files:**

- Create: `src/core/artifact-service.ts`
- Test: `src/core/__tests__/artifact-service.test.ts`

- [ ] Implement selected-rule resolution:
  - request `artifactRuleIds === undefined` uses `profile.defaultArtifactRuleIds`;
  - request ids must all exist in `profile.artifactRules`;
  - duplicate ids are de-duped in request order;
  - unknown ids return `BAD_REQUEST`.
- [ ] Implement finalization:
  - scan only selected rules;
  - persist found artifacts;
  - return found artifact records plus missing required rule ids;
  - if a required rule is missing after a successful Claude result, caller can fail the run with `ARTIFACT_REQUIRED_MISSING`;
  - if Claude already failed, persist any found artifacts but do not replace the original CLI failure code.
  - if glob/stat/hash work throws during artifact finalization, return a structured scanner failure to the caller instead of leaving the run non-terminal.
- [ ] Implement read helpers:
  - `listRunArtifacts({ client, runId })`;
  - `getRunArtifactDownload({ client, runId, artifactId })`;
  - download helper resolves `artifact.relativePath` under workspace cwd and verifies it remains inside the workspace.
- [ ] Write tests that:
  - required missing is reported;
  - non-required missing is not fatal;
  - scanner/hash exceptions are surfaced so run-service can fail terminally instead of hanging;
  - found artifacts are persisted;
  - download helper never exposes absolute paths in returned public metadata;
  - deleted-on-disk artifact returns `NOT_FOUND`;
  - cross-client reads are denied via run/client scoping.
- [ ] Run:

```bash
pnpm test -- src/core/__tests__/artifact-service.test.ts
```

Expected: artifact service tests pass.

**Acceptance:** Artifact domain behavior is reusable from run finalization and HTTP routes.

### Task 9: Run Service Generate Integration

**Files:**

- Modify: `src/core/run-service.ts`
- Modify: `src/core/run-events.ts`
- Modify: `src/core/run-types.ts`
- Modify: `src/core/event-visibility.ts`
- Test: `src/core/__tests__/run-service.test.ts`
- Test: `src/core/__tests__/run-events.test.ts`
- Test: `src/core/__tests__/event-visibility.test.ts`

- [ ] Add `artifact_finalized` event type:

```ts
{
  type: 'artifact_finalized';
  artifact: {
    id: string;
    runId: string;
    ruleId: string;
    role: string;
    relativePath: string;
    fileName: string;
    mimeType: string | null;
    size: number | null;
    mtime: number | null;
    sha256: string | null;
  };
}
```

- [ ] Mark `artifact_finalized` as `quiet` in `event-visibility.ts`.
- [ ] Add these error codes to `daemonErrorCodes`:
  - `SKILL_UNAVAILABLE`: an allowlisted skill could not be found/read from configured `profile.skillRoots` after queued run creation.
  - `SKILL_STAGING_FAILED`: the daemon resolved the skill but could not stage its side files into the workspace.
  - `ARTIFACT_SCAN_FAILED`: artifact glob/stat/hash/persist failed after the Claude process completed; the run must still reach terminal failed state.
- [ ] Replace Phase 1 generate rejection with:
  - `kind=generate` performs synchronous `skillId` membership validation against `profile.allowedSkillIds` before queued insert;
  - disallowed `skillId` throws `SKILL_NOT_ALLOWED` 400 and does not create a run row;
  - skill filesystem resolution happens in async `startRun` after queued insert;
  - allowlisted but missing/unreadable skill files fail the durable run with `SKILL_UNAVAILABLE`;
  - `kind=revise` still has no skill behavior and cannot pass `skillId` due validation.
- [ ] Validate selected artifact rules before queued insert so a bad request does not create a run row.
- [ ] Keep queued insert atomic with messages and profile snapshot.
- [ ] Extend `RunState` to remember:
  - selected artifact rule ids;
  - resolved skill for generate;
  - staged skill result once available.
- [ ] In async start:
  - resolve the generate skill from `profile.skillRoots`;
  - if the resolved skill has side files, stage it before building invocation;
  - if staging fails, finish the run as `failed` with `SKILL_STAGING_FAILED` and do not spawn Claude;
  - after every awaited step before `runnerFactory()`, re-check `state.terminal` and return if a cancel already finished the run;
  - compose the final prompt;
  - pass only `stagedSkill.absoluteRoot` as `extraAllowedDirs` when side files were staged;
  - pass no `extraAllowedDirs` for skills without side files;
  - never pass `profile.allowedInputRoots`;
  - never pass full `profile.skillRoots`.
- [ ] Update terminal flow:
  - on CLI completion and when not canceled, scan artifacts before emitting `end`;
  - persist artifacts with `replaceArtifactsForRun`;
  - emit `artifact_finalized` events for found artifacts;
  - `artifact_finalized` events are consumed by the message accumulator and persisted in assistant `events_json`;
  - if CLI status is `succeeded` and required artifacts are missing, emit an `error` event with code `ARTIFACT_REQUIRED_MISSING` and rewrite final status to `failed`;
  - if artifact scan/persist/hash throws, emit an `error` event with code `ARTIFACT_SCAN_FAILED`, rewrite final status to `failed`, and still reach terminal;
  - call `accumulator.flushTerminal({ runStatus: finalStatus })` with the rewritten final status, not the raw CLI status;
  - emit `end` only after artifact and error events have been emitted and consumed by the accumulator;
  - then call `updateRunTerminal` with the same final status;
  - canceled runs do not run artifact scan.
- [ ] Add run-service tests:
  - generate no longer returns `kind=generate requires Phase 2 skill support`;
  - disallowed skill returns synchronous `SKILL_NOT_ALLOWED` and inserts no run row;
  - allowlisted but missing skill files create a queued run and then finish it as `failed` with `SKILL_UNAVAILABLE`;
  - staging failure creates a queued run and then finishes it as `failed` with `SKILL_STAGING_FAILED`;
  - allowed generate stages skill and starts fake runner;
  - generate skill with no side files does not stage and passes no `extraAllowedDirs`;
  - fake runner input prompt contains skill body and staged relative root;
  - fake runner input extra dirs contain staged skill dir only;
  - fake runner input extra dirs do not contain `allowedInputRoots` or full `skillRoots`;
  - successful generate with required output writes artifacts and succeeds;
  - successful generate missing required output fails with `ARTIFACT_REQUIRED_MISSING`;
  - artifact scan/hash exception fails the run terminally and does not leave it `running`;
  - missing required artifact still leaves assistant `content/events_json` flushed for run detail;
  - `artifact_finalized` appears in durable assistant `events_json`;
  - `artifact_finalized` and `ARTIFACT_REQUIRED_MISSING` error events appear before the terminal `end` event;
  - revise runs still do not stage or inject skill body.
- [ ] Run:

```bash
pnpm test -- src/core/__tests__/run-service.test.ts src/core/__tests__/run-events.test.ts src/core/__tests__/event-visibility.test.ts
```

Expected: run-service and event tests pass.

**Acceptance:** `generate` is runnable only through the safe skill path and required artifact failures are durable.

### Task 10: Artifact HTTP Routes

**Files:**

- Create: `src/http/artifacts-routes.ts`
- Modify: `src/http/app.ts`
- Modify: `src/index.ts`
- Test: `src/http/__tests__/artifacts-routes.test.ts`
- Test: `src/__tests__/index.test.ts`

- [ ] Add route:

```text
GET /api/runs/:runId/artifacts
```

Response:

```json
{
  "artifacts": [
    {
      "id": "artifact_123",
      "runId": "run_456",
      "workspaceId": "ws_123",
      "ruleId": "report-docx",
      "role": "primary",
      "relativePath": "output/report.docx",
      "fileName": "report.docx",
      "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "size": 1234,
      "mtime": 1770000000000,
      "sha256": "..."
    }
  ]
}
```

- [ ] Add route:

```text
GET /api/runs/:runId/artifacts/:artifactId/download
```

- [ ] Download behavior:
  - current client must be authorized to read the run;
  - artifact must belong to `runId`;
  - route streams the file;
  - route sets `Content-Type`;
  - route sets `Content-Disposition: attachment; filename="<artifact.fileName>"`;
  - route never returns sandbox absolute path in JSON errors or success headers.
- [ ] Write route tests:
  - unauthenticated requests fail;
  - unauthorized client cannot list or download another client run artifact;
  - list response has no absolute path fields;
  - download response body equals file content;
  - missing artifact id returns `404 NOT_FOUND`;
  - DB row whose file no longer exists returns `404 NOT_FOUND`;
  - malformed run id/artifact id does not expose internal paths.
- [ ] Ensure `createApp()` wires artifacts routes only when an artifact service is provided, matching existing optional run-service wiring in tests.
- [ ] Ensure importing `src/index.ts` still does not start the server.
- [ ] Run:

```bash
pnpm test -- src/http/__tests__/artifacts-routes.test.ts src/__tests__/index.test.ts
```

Expected: HTTP artifact route tests pass.

**Acceptance:** Artifact APIs are client-scoped, stream files safely, and reveal no sandbox absolute paths.

### Task 11: Existing Contract And Route Regression

**Files:**

- Modify tests as needed:
  - `src/http/__tests__/runs-routes.test.ts`
  - `src/http/__tests__/validation.test.ts`
  - `src/config/__tests__/profiles.test.ts`

- [ ] Update Phase 1 tests that expected generate rejection to now expect generate success only when a valid skill exists.
- [ ] Keep validation tests that:
  - `kind=generate` without `skillId` fails;
  - `kind=revise` with `skillId` fails;
  - request cannot inline `originId/userId/projectId`;
  - request cannot pass arbitrary artifact rule patterns.
- [ ] Add profile config tests if missing:
  - `defaultArtifactRuleIds` must exist in `artifactRules`;
  - `allowedSkillIds` can be empty for revise-only profiles;
  - `skillRoots` are config-only and absent from public profile responses.
- [ ] Add contract tests that `SKILL_UNAVAILABLE`, `SKILL_STAGING_FAILED`, and `ARTIFACT_SCAN_FAILED` are accepted daemon error codes.
- [ ] Historical note: Phase 1 originally exposed `tool_result` at `normal` visibility. A later review changed the public event contract so `tool_result` remains in internal persistence/logs but is filtered from SSE/run detail responses.
- [ ] Run:

```bash
pnpm test -- src/http/__tests__/runs-routes.test.ts src/http/__tests__/validation.test.ts src/config/__tests__/profiles.test.ts
```

Expected: existing API contract remains intact.

**Acceptance:** Phase 2 does not regress Phase 0a/0/1 API guarantees.

### Task 12: Full Verification And Commit

**Files:**

- Modify docs only if implementation revealed a necessary clarification:
  - `docs/claude-code-runner-daemon-design.md`
  - `docs/phase-2-skill-artifact-plan.md`

- [ ] Run targeted grep checks:

```bash
rg -n "from ['\"]/?home/orangels/ls_dev/lanceDesign|lanceDesign/apps/daemon" src
rg -n "run_events|CREATE TABLE IF NOT EXISTS run_events" src
rg -n "chokidar|multer|prom-client|undici|fetch\\(|S3|signed URL|metrics|upload" src
rg -n "allowedInputRoots|skillRoots" src/core/run-service.ts src/core/claude-adapter.ts
```

Expected:

- No lanceDesign import.
- No `run_events` table.
- No watcher/upload/remote/metrics implementation.
- `allowedInputRoots` is not passed to `--add-dir`.
- `skillRoots` is only used for registry lookup, not child process allowlisting.

- [ ] Run full validation:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected:

- TypeScript passes.
- All tests pass.
- Production build succeeds.

- [ ] Commit Phase 2 implementation:

```bash
git add src docs package.json pnpm-lock.yaml
git commit -m "feat: add phase 2 skill artifact flow"
```

Adjust `git add` paths to actual changed files; do not add `.omc/`.

**Acceptance:** Phase 2 implementation is ready for CC review.

## What Must Explicitly Wait

Do not implement these in Phase 2:

- Artifact watcher or running `artifact_candidate` events.
- Upload API.
- Remote URL fetch.
- S3/object storage pull.
- Browser-facing CORS.
- Signed download URLs.
- Full `GET /api/runs/:runId/logs` behavior.
- Metrics endpoint or `prom-client` exposure.
- Queue worker, global/profile concurrency scheduling, or queue capacity behavior beyond the existing same-workspace active-run guard.
- Total run timeout scheduler beyond existing Phase 1 inactivity watchdog.
- OS-level sandboxing, separate uid execution, containers, seccomp/firejail, or permission hooks.
- User/global Claude Code skill discovery.
- Product-specific lanceDesign systems: design systems, craft, memory, critique, live artifact MCP, deployments, project tabs, routines/orbit, media generation, local-client runtime.

## Stage Acceptance Criteria

### Skill Stage Acceptance

- `kind=generate` resolves only `profile.allowedSkillIds`.
- Disallowed skill ids fail synchronously with `SKILL_NOT_ALLOWED` and do not create run rows.
- Allowlisted but unavailable skill files fail the durable run with `SKILL_UNAVAILABLE`.
- Only profile-owned `skillRoots` are scanned.
- Active skill side files are copied into `.claude-runner-skills/<folder>/`.
- Skills without side files do not require staging or `--add-dir`.
- Staging failure fails the durable run with `SKILL_STAGING_FAILED` before spawning Claude.
- No symlink path can mutate the source skill directory.
- Generate prompt includes skill body and staged skill guidance.
- Revise prompt remains skill-free.

### Artifact Stage Acceptance

- Selected `artifactRuleIds` are validated against profile config.
- Missing `artifactRuleIds` uses profile defaults.
- Terminal scan uses workspace-relative profile glob rules only.
- Found artifacts are stored in SQLite with relative paths only.
- Required missing artifacts fail successful Claude runs with `ARTIFACT_REQUIRED_MISSING`.
- Non-required missing artifacts do not fail the run.
- Artifact scan/stat/hash/persist exceptions fail terminally with `ARTIFACT_SCAN_FAILED`.
- `artifact_finalized` and required-missing `error` events are emitted before terminal `end`.
- `run_messages.run_status` and `runs.status` use the same final status after required-missing rewrites.

### HTTP Stage Acceptance

- `GET /api/runs/:runId/artifacts` returns authorized artifact metadata.
- `GET /api/runs/:runId/artifacts/:artifactId/download` streams authorized files.
- API responses and error bodies do not expose sandbox absolute paths.
- Cross-client reads are denied unless the client is admin.

### Whole Phase Acceptance

- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- No lanceDesign source import exists.
- No `run_events` table exists.
- No Phase 3 queue/metrics/hardening behavior is added.
- No upload/remote/artifact watcher behavior is added.
- Phase 2 branch is committed and ready for CC review before merge.

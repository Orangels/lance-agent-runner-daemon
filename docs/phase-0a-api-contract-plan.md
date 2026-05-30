# Phase 0a API Contract Plan

## Goal

Freeze the first-version API and shared contract primitives before implementing daemon behavior. This phase intentionally produces contract types, validation schemas, structured errors, and tests only.

## Inputs

Read and follow:

- `AGENTS.md`
- `REFERENCE.md`
- `docs/claude-code-runner-daemon-design.md`
- `docs/claude-code-runner-daemon-migration-assessment.md`
- `docs/claude-code-runner-daemon-implementation-plan.md`

Reference only, do not import:

- `/home/orangels/ls_dev/lanceDesign/packages/contracts/src/api/chat.ts`
- `/home/orangels/ls_dev/lanceDesign/packages/contracts/src/sse/chat.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/chat-routes.ts`
- `/home/orangels/ls_dev/lanceDesign/apps/daemon/src/runs.ts`

## Files

Create:

- `src/core/run-types.ts`
- `src/core/errors.ts`
- `src/http/validation.ts`
- `src/core/__tests__/run-types.test.ts`
- `src/http/__tests__/validation.test.ts`

Modify:

- `package.json`

## Contract Decisions

- `POST /api/workspaces` accepts `profileId` and `workspace.originId/userId/projectId`.
- `POST /api/workspaces/:workspaceId/prepare` accepts `files[].sourcePath` and `files[].targetPath`.
- `POST /api/runs` accepts `profileId`, `workspaceId`, `kind`, `prompt`, optional `skillId`, optional `model`, optional `artifactRuleIds`, optional `eventVisibility`, and optional `metadata`.
- `POST /api/runs` must reject direct `originId`, `userId`, `projectId`, `workspace`, or absolute cwd fields.
- `kind=generate` requires `skillId`.
- `kind=revise` forbids `skillId`.
- Workspace prepare `targetPath` must be workspace-relative and must not target `.claude-runner-skills`.
- Run statuses are exactly `queued`, `running`, `succeeded`, `failed`, `canceled`, `interrupted`.
- Event visibility values are exactly `quiet`, `normal`, `debug`.
- First-version workspace directories are exactly `input`, `output`, `work`, `.claude-runner-skills`.
- First-version message flush strategy is a shared contract constant:
  - `throttleMs = 500`
  - create user message and assistant draft at run creation
  - force flush before terminal transition
  - preserve last successful partial write after daemon crash

## TDD Checklist

- [ ] Add tests for shared status/visibility/workspace constants.
- [ ] Add tests for structured error responses.
- [ ] Add tests that reject inline workspace identity on run create.
- [ ] Add tests that reject `generate` without `skillId`.
- [ ] Add tests that reject `revise` with `skillId`.
- [ ] Add tests that reject unknown status filters.
- [ ] Add tests that reject unknown event visibility values.
- [ ] Add tests that reject absolute prepare `targetPath`.
- [ ] Add tests that reject `..` prepare `targetPath`.
- [ ] Add tests that reject `.claude-runner-skills` prepare targets.
- [ ] Watch the tests fail before implementation.
- [ ] Implement minimal contract modules.
- [ ] Run `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Explicit Non-Scope

- No Express route implementation.
- No SQLite schema.
- No workspace directory creation.
- No file copying.
- No Claude Code spawning.
- No SSE implementation.
- No skill registry or staging.
- No artifact scan or download.
- No queue/concurrency scheduler.
- No upload API, remote URL pull, metrics endpoint, browser auth, OS-level isolation, permission hooks, or lanceDesign product logic.

## Follow-Up Notes For Later Phases

- Phase 0 route/middleware work must map zod validation failures into structured daemon errors, including `INVALID_PATH_SEGMENT` and `PATH_NOT_ALLOWED` where appropriate.
- Phase 0/1 should decide whether HTTP query schemas stay strict or strip unknown query parameters before routes are finalized.
- Phase 0/1 should add request size and field length limits for large fields such as `prompt`, `skillId`, `model`, and metadata.

## Acceptance Criteria

- Contract tests pass.
- TypeScript build passes.
- `POST /api/runs` contract only references `workspaceId`.
- Structured error codes are explicit and importable.
- Validation schemas normalize/guard first-version request shapes.
- Future Phase 0/1 implementation can import these contracts without re-deciding names.

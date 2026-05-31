# Directory Guide

This file is the source of truth for agents entering this repository.

This repository implements a standalone Claude Code CLI runner daemon. It is not a lanceDesign app package, and it should not import lanceDesign private source directly. lanceDesign is a reference implementation only.

## Core Documentation

Read these first:

- `REFERENCE.md` — reference map back to lanceDesign and migration boundaries.
- `docs/claude-code-runner-daemon-design.md` — target daemon design.
- `docs/claude-code-runner-daemon-migration-assessment.md` — migration feasibility and code reuse map.
- `docs/claude-code-runner-daemon-version-roadmap.md` — current first-version landing-test scope and later-version backlog.
- `docs/business-run-chat-integration-guide.md` — business-side generate/revise integration flow.
- `docs/api-reference.md` — current HTTP/SSE API request and response reference.
- `docs/configuration-reference.md` — daemon config keys, relative path behavior, and deployment notes.

## Reference Repository

The source reference repository is:

```text
/home/orangels/ls_dev/lanceDesign
```

Use it to inspect implementation patterns, not as a package dependency.

Important: do not copy lanceDesign product logic wholesale. The new daemon should reuse only the Claude Code CLI pipeline ideas and carefully selected utility code described in `REFERENCE.md`.

## Project Shape

Expected first-version source layout:

```text
src/
  config/
  core/
  db/
  http/
  index.ts
docs/
REFERENCE.md
AGENTS.md
CLAUDE.md
package.json
tsconfig.json
```

Keep source code under `src/`. Keep design and migration notes under `docs/`.

## Implementation Boundary

This daemon exposes HTTP/SSE APIs for other systems. It must not be coupled to a specific business product.

First-version API contract:

```text
POST /api/workspaces
POST /api/workspaces/:workspaceId/prepare
POST /api/runs
GET  /api/runs
GET  /api/runs/:runId/events
GET  /api/runs/:runId
POST /api/runs/:runId/cancel
GET  /api/runs/:runId/artifacts
GET  /api/runs/:runId/artifacts/:artifactId/download
GET  /api/runs/:runId/logs
GET  /api/profiles
GET  /api/health
```

Second-version Phase 4 extension:

```text
POST /api/workspaces/:workspaceId/files
```

`POST /api/runs` references `workspaceId`; it does not inline `originId/userId/projectId`.

## Security Boundary

First version uses directory isolation only.

It does not provide OS-level isolation, separate uid execution, containers, seccomp/firejail, or Claude Code permission hooks.

This means:

- Treat callers, profiles, and deployment environments as trusted.
- Do not describe the workspace directory checks as a strong sandbox.
- If `permissionMode` uses `bypassPermissions`, Claude Code child processes have the daemon process user's file and network permissions.

## Coding Standards

- Use TypeScript for all project-owned source files.
- Use ESM modules (`"type": "module"`).
- Prefer small modules with explicit boundaries:
  - `src/http/*` handles Express routing only.
  - `src/core/*` contains runner/domain logic and must not depend on Express.
  - `src/db/*` owns SQLite schema and repositories.
  - `src/config/*` owns config, profile, auth, and env validation.
- Do not add product-specific lqBot or lanceDesign business logic to core modules.
- Do not expose sandbox absolute paths through API responses.
- Do not let requests override `claudeConfigDir`, `claudeBin`, `skillRoots`, `allowedInputRoots`, or `permissionMode`.
- Validate all path segments and all workspace-relative paths.
- Store durable run state in SQLite. `runs` must be inserted as `queued` at run create time.
- Do not add a `run_events` table in the first version. Use in-memory SSE buffer for live/short reconnect replay and `run_messages.events_json` for durable history.

## Style

- Keep comments short and useful.
- Prefer named helpers for security-sensitive checks such as path validation.
- Avoid broad abstractions until the first implementation proves a repeated pattern.
- Use structured error codes for API failures.
- Keep generated output, runtime data, and local sandbox files out of git.

## Commands

Package manager:

```bash
corepack enable
pnpm install
```

Common commands:

```bash
pnpm typecheck
pnpm build
pnpm dev
pnpm start
```

There is intentionally no root monorepo tooling here. This project is a standalone daemon.

## Validation

Before calling implementation work ready, run at least:

```bash
pnpm typecheck
pnpm build
```

When tests are added, also run the relevant package test command.

## Git

Do not add co-author trailers to commits.

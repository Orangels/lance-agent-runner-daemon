# apps/AGENTS.md

Follow the root `AGENTS.md` first. This file records app-level boundaries for
`apps/` in this standalone Claude Code runner repository.

This repository is not a lanceDesign package. Use lanceDesign only as a
reference implementation; do not import lanceDesign private source directly.

## Active Apps

- `apps/daemon`: Generic Claude Code runner daemon. It owns Express REST/SSE
  APIs, SQLite persistence, workspaces, runs, profiles, skills, skill staging,
  prompt/context composition, snapshots, logs, and daemon artifacts. It must
  stay business-agnostic and must not understand RPA DSL, Playwright execution,
  `executionId`, screenshots, or RPA storage.
- `apps/web`: Local browser test console for the daemon generate/revise
  integration flow. It is a development/demo console for daemon APIs, not a
  product app. Do not add RPA product workflow or business-specific behavior
  here.
- `apps/rpa-local-web`: Local B/S RPA MVP app. It owns RPA product workflow,
  RPA DSL validation, generated-flow artifact validation, local executor logic,
  execution storage, RPA-specific backend routes, and RPA UI. It may call the
  daemon through HTTP/SSE client code, but must not import daemon private source
  modules.

## Cross-App Boundaries

- Keep `apps/daemon` reusable as a generic agent runner. Do not move RPA routes,
  RPA execution storage, Python/Playwright process management, screenshots,
  traces, or `.rpa.zip` import/export into daemon core.
- Keep `apps/rpa-local-web` as the owner of RPA product semantics. If a change
  mentions `flow.dsl.json`, `flow.hardened.py`, `run.params.json`,
  `executionId`, screenshots, traces, downloads, or RPA verification UI, it
  belongs in `apps/rpa-local-web` unless the user explicitly asks otherwise.
- Keep `apps/web` focused on daemon API testing and manual smoke testing. It
  should not become a second RPA frontend.
- App code should communicate across app boundaries through documented HTTP/SSE
  APIs or small typed clients, not by importing another app's `src/` internals.

## Daemon Layout

- `apps/daemon/src/http/*` handles Express routing only.
- `apps/daemon/src/core/*` contains runner/domain logic and must not depend on
  Express.
- `apps/daemon/src/db/*` owns SQLite schema and repositories.
- `apps/daemon/src/config/*` owns config, profiles, auth, and environment
  validation.
- `apps/daemon/skills/*` contains daemon-managed business skills. Skills may be
  business-specific, but daemon core must treat them as data/instructions.

## RPA Local Web Layout

- `apps/rpa-local-web/src/server/*` owns server-side RPA Web code.
- `apps/rpa-local-web/src/server/routes/*` owns RPA Web backend route modules.
- `apps/rpa-local-web/src/server/executor/*` owns local execution lifecycle,
  child process management, execution storage, events, logs, screenshots, and
  execution artifact collection.
- `apps/rpa-local-web/src/server/validators/*` owns RPA DSL and artifact
  validation.
- `apps/rpa-local-web/src/shared/*` owns browser/server shared types and schema
  contracts.
- `apps/rpa-local-web/src/api/*` owns browser-side API clients.

## Router Layout

- Existing daemon endpoints belong in the matching `apps/daemon/src/http/*`
  route file. Add a new daemon route module only when the endpoint introduces a
  distinct generic daemon domain.
- `apps/daemon/src/http/app.ts` wires route modules and process-wide
  middleware. Avoid adding domain handlers directly there unless the route is
  process/bootstrap-wide.
- Existing RPA Web endpoints belong in the matching
  `apps/rpa-local-web/src/server/routes/*` file. Add a new RPA route module
  when it introduces a distinct RPA Web domain.
- `apps/rpa-local-web/src/server/server.ts` should remain app assembly:
  middleware, server-wide health/config routes, route registration, and
  Vite/static serving.

## Test Layout

- App tests live in each app's `tests/` directory, sibling to `src/`.
- Keep app `src/` directories source-only; do not add new `*.test.ts` or
  `*.test.tsx` files under `src/`.
- Preserve source-relative subpaths inside `tests/` when useful:
  - `apps/daemon/tests/core/run-service.test.ts`
  - `apps/web/tests/components/ChatPanel.test.tsx`
  - `apps/rpa-local-web/tests/server/executor/python-playwright-executor.test.ts`
- Test setup files belong in `apps/<app>/tests/setup.ts`, not
  `apps/<app>/src/test/`.
- Playwright UI automation, if added later, should live in a dedicated e2e
  location and should not be mixed into app source directories without an
  explicit plan.

## Runtime Data

- Keep generated output, local runtime data, execution storage, logs, caches,
  and sandbox files out of git.
- Daemon runtime data belongs under daemon-managed paths such as
  `.claude-runner/`.
- RPA local execution data belongs under RPA Web-owned storage such as
  `.rpa-local/`.
- Do not expose daemon workspace paths, RPA Web storage roots, execution
  directories, or other local absolute paths through browser-facing API
  responses.

## Common App Commands

```bash
pnpm --filter @lance-agent-runner/daemon typecheck
pnpm --filter @lance-agent-runner/daemon test
pnpm --filter @lance-agent-runner/daemon build

pnpm --filter @lance-agent-runner/web typecheck
pnpm --filter @lance-agent-runner/web test
pnpm --filter @lance-agent-runner/web build

pnpm --filter @lance-agent-runner/rpa-local-web typecheck
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm --filter @lance-agent-runner/rpa-local-web build
```

# App Tests Layout Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move app tests out of `apps/<app>/src/**` into `apps/<app>/tests/**` so `src/` is source-only while preserving current test behavior.

**Architecture:** This is a mechanical layout migration, not a feature slice. Each app keeps its source code under `src/`, moves tests to a sibling `tests/` tree that mirrors the source domain structure, and updates Vitest/TypeScript config to use the new test roots. No daemon/RPA/web product logic should change.

**Tech Stack:** TypeScript ESM, Vitest, Vite React test setup, app-level `tsconfig*.json`, `git mv`, root pnpm workspace scripts.

---

## Scope Boundary

This migration includes:

- Moving all app-owned `*.test.ts` and `*.test.tsx` files from `src/` to `tests/`.
- Moving test setup files from `src/test/` to `tests/setup.ts`.
- Updating test import paths after the move.
- Updating Vitest include/setup paths.
- Updating TypeScript configs so source configs remain source-focused and test configs typecheck tests.
- Updating `apps/AGENTS.md` to make `apps/<app>/tests/` the normative test layout.
- Running the full test/typecheck/build verification suite.

This migration does not include:

- Changing test behavior or assertions.
- Renaming production modules.
- Moving source helper files that are imported by production code.
- Adding new feature tests unrelated to layout.
- Introducing path aliases.
- Changing daemon/RPA/Web app boundaries.

## Current State

Tests currently live under source directories:

```text
apps/daemon/src/**/__tests__/*.test.ts
apps/web/src/**/*.test.ts
apps/web/src/**/*.test.tsx
apps/web/src/test/setup.ts
apps/rpa-local-web/src/**/*.test.ts
apps/rpa-local-web/src/**/*.test.tsx
apps/rpa-local-web/src/test/setup.ts
```

Current Vitest configs include `src/**/*.test*`, so they must be changed when files move.

Current `apps/AGENTS.md` documents the current near-source layout. The implementation should update it to the target layout in this plan.

## Target Layout

```text
apps/daemon/
  src/
  tests/
    index.test.ts
    config/
    core/
    db/
    http/

apps/web/
  src/
  tests/
    setup.ts
    App.test.tsx
    app-flows.test.tsx
    api/
    chat/
    components/

apps/rpa-local-web/
  src/
  tests/
    setup.ts
    App.test.tsx
    api/
    server/
    shared/
```

Import path rule after migration:

- A test under `apps/daemon/tests/core/run-service.test.ts` imports source from `../../src/core/run-service.js`.
- A test under `apps/web/tests/components/ChatPanel.test.tsx` imports source from `../../src/components/ChatPanel.js`.
- A test under `apps/rpa-local-web/tests/server/executor/process-manager.test.ts` imports source from `../../../src/server/executor/process-manager.js`.
- Side-effect package imports such as `@testing-library/jest-dom/vitest` are unchanged.

## Migration Safety Rules

- Use `git mv` for moved test files so history is preserved.
- Keep source-relative subpaths where practical: `src/core/__tests__/x.test.ts` becomes `tests/core/x.test.ts`.
- Do not edit production code unless a TypeScript config path requires it.
- Do not add path aliases in this migration. Relative imports are noisy but explicit.
- Run package tests immediately after each app migration before moving to the next app.
- If sandbox prevents local port binding or nested Node child process stdout/stderr, rerun affected RPA Web tests outside sandbox with approval.

## File Map

Create:

- `apps/daemon/tsconfig.test.json`
  - Typechecks daemon tests under `tests/` alongside `src/`.
- `apps/web/tsconfig.test.json`
  - Typechecks web tests under `tests/` with Vitest/jsdom/testing-library types.
- `apps/rpa-local-web/tsconfig.test.json`
  - Typechecks browser-side RPA Web tests under `tests/` with Vitest/jsdom/testing-library types.

Move:

- `apps/daemon/src/__tests__/index.test.ts` -> `apps/daemon/tests/index.test.ts`
- `apps/daemon/src/config/__tests__/*.test.ts` -> `apps/daemon/tests/config/`
- `apps/daemon/src/core/__tests__/*.test.ts` -> `apps/daemon/tests/core/`
- `apps/daemon/src/db/__tests__/*.test.ts` -> `apps/daemon/tests/db/`
- `apps/daemon/src/http/__tests__/*.test.ts` -> `apps/daemon/tests/http/`
- `apps/web/src/App.test.tsx` -> `apps/web/tests/App.test.tsx`
- `apps/web/src/__tests__/app-flows.test.tsx` -> `apps/web/tests/app-flows.test.tsx`
- `apps/web/src/api/__tests__/*.test.ts` -> `apps/web/tests/api/`
- `apps/web/src/chat/__tests__/*.test.ts` -> `apps/web/tests/chat/`
- `apps/web/src/components/__tests__/*.test.tsx` -> `apps/web/tests/components/`
- `apps/web/src/test/setup.ts` -> `apps/web/tests/setup.ts`
- `apps/rpa-local-web/src/App.test.tsx` -> `apps/rpa-local-web/tests/App.test.tsx`
- `apps/rpa-local-web/src/api/*.test.ts` -> `apps/rpa-local-web/tests/api/`
- `apps/rpa-local-web/src/server/**/*.test.ts` -> `apps/rpa-local-web/tests/server/**`
- `apps/rpa-local-web/src/shared/*.test.ts` -> `apps/rpa-local-web/tests/shared/`
- `apps/rpa-local-web/src/test/setup.ts` -> `apps/rpa-local-web/tests/setup.ts`

Modify:

- `apps/daemon/vitest.config.ts`
- `apps/daemon/tsconfig.json`
- `apps/daemon/package.json`
- `apps/web/vitest.config.ts`
- `apps/web/tsconfig.json`
- `apps/web/package.json`
- `apps/rpa-local-web/vitest.config.ts`
- `apps/rpa-local-web/tsconfig.json`
- `apps/rpa-local-web/tsconfig.server.test.json`
- `apps/rpa-local-web/package.json`
- `apps/AGENTS.md`

## Task 1: Preflight Inventory And Baseline

**Files:**

- Read-only checks only.

- [ ] **Step 1: Confirm working tree state**

Run:

```bash
git status --short
```

Expected:

- Either clean, or only known planning/doc files are present.
- If `apps/AGENTS.md` is still uncommitted from the app boundary work, keep it and update it in Task 6 rather than overwriting it.

- [ ] **Step 2: Capture current test inventory**

Run:

```bash
find apps -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort
```

Expected:

- All test files are still under `apps/*/src/**` before migration starts.
- Use this output as the migration checklist.

- [ ] **Step 3: Run baseline verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: PASS.

If `pnpm test` fails in the sandbox with port binding or nested child process limitations, rerun it outside sandbox. Do not start the migration from a failing baseline.

- [ ] **Step 4: Baseline daemon test typecheck explicitly**

Daemon tests are currently excluded from `apps/daemon/tsconfig.json`, so the existing `pnpm typecheck` baseline does not typecheck daemon tests. This migration intentionally adds daemon test typechecking. Run a temporary baseline check before moving files:

```bash
cd apps/daemon
cat > .tmp-tsconfig.test-baseline.json <<'JSON'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
JSON
pnpm exec tsc -p .tmp-tsconfig.test-baseline.json --noEmit
rm .tmp-tsconfig.test-baseline.json
cd ../..
```

Expected: PASS.

If this fails, the failing daemon test types are pre-existing but previously unchecked. Fix them inside this migration before moving on, and keep the fixes behavior-preserving.

## Task 2: Migrate Daemon Tests

**Files:**

- Move: `apps/daemon/src/**/__tests__/*.test.ts`
- Create: `apps/daemon/tsconfig.test.json`
- Modify: `apps/daemon/vitest.config.ts`
- Modify: `apps/daemon/tsconfig.json`
- Modify: `apps/daemon/package.json`

- [ ] **Step 1: Move daemon test files**

Run:

```bash
mkdir -p apps/daemon/tests/config apps/daemon/tests/core apps/daemon/tests/db apps/daemon/tests/http
git mv apps/daemon/src/__tests__/index.test.ts apps/daemon/tests/index.test.ts
git mv apps/daemon/src/config/__tests__/*.test.ts apps/daemon/tests/config/
git mv apps/daemon/src/core/__tests__/*.test.ts apps/daemon/tests/core/
git mv apps/daemon/src/db/__tests__/*.test.ts apps/daemon/tests/db/
git mv apps/daemon/src/http/__tests__/*.test.ts apps/daemon/tests/http/
rmdir apps/daemon/src/__tests__ apps/daemon/src/config/__tests__ apps/daemon/src/core/__tests__ apps/daemon/src/db/__tests__ apps/daemon/src/http/__tests__
```

Expected:

- No daemon `*.test.ts` files remain under `apps/daemon/src/`.

- [ ] **Step 2: Update daemon relative imports**

For moved daemon tests, rewrite relative imports so they point to `src/` from the new `tests/` location:

```text
apps/daemon/tests/index.test.ts
  ../config/profiles.js -> ../src/config/profiles.js
  ../db/connection.js -> ../src/db/connection.js
  ../db/repositories.js -> ../src/db/repositories.js
  ../db/schema.js -> ../src/db/schema.js
  ../index.js -> ../src/index.js

apps/daemon/tests/config/*.test.ts
  ../<module>.js -> ../../src/config/<module>.js
  ../../core/<module>.js -> ../../src/core/<module>.js

apps/daemon/tests/core/*.test.ts
  ../<module>.js -> ../../src/core/<module>.js
  ../../config/<module>.js -> ../../src/config/<module>.js
  ../../db/<module>.js -> ../../src/db/<module>.js

apps/daemon/tests/db/*.test.ts
  ../<module>.js -> ../../src/db/<module>.js

apps/daemon/tests/http/*.test.ts
  ../<module>.js -> ../../src/http/<module>.js
  ../../config/<module>.js -> ../../src/config/<module>.js
  ../../core/<module>.js -> ../../src/core/<module>.js
  ../../db/<module>.js -> ../../src/db/<module>.js
```

After editing, run:

```bash
rg -n "from ['\"]\\.\\.?/|vi\\.mock\\(['\"]\\.\\.?/" apps/daemon/tests
```

Expected:

- Relative imports exist, but each one points through `../src/` or `../../src/` according to the table above.
- No import points back into `tests/` except explicit test helper imports if such helpers are introduced later.

- [ ] **Step 3: Update daemon Vitest config**

Edit `apps/daemon/vitest.config.ts` to:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
```

- [ ] **Step 4: Keep daemon source tsconfig source-only**

Edit `apps/daemon/tsconfig.json` to remove source test exclusions and exclude the new test root:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 5: Add daemon test tsconfig**

Create `apps/daemon/tsconfig.test.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.test.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 6: Update daemon typecheck script**

Edit `apps/daemon/package.json`:

```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit"
  }
}
```

Only change the `typecheck` script. Keep other scripts unchanged.

- [ ] **Step 7: Verify daemon migration**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test
pnpm --filter @lance-agent-runner/daemon typecheck
pnpm --filter @lance-agent-runner/daemon build
find apps/daemon/src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \)
```

Expected:

- Tests, typecheck, and build PASS.
- The final `find` command prints no files.

## Task 3: Migrate Web Test Console Tests

**Files:**

- Move: `apps/web/src/**/*.test.ts`
- Move: `apps/web/src/**/*.test.tsx`
- Move: `apps/web/src/test/setup.ts`
- Create: `apps/web/tsconfig.test.json`
- Modify: `apps/web/vitest.config.ts`
- Modify: `apps/web/tsconfig.json`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Move web test files and setup**

Run:

```bash
mkdir -p apps/web/tests/api apps/web/tests/chat apps/web/tests/components
git mv apps/web/src/App.test.tsx apps/web/tests/App.test.tsx
git mv apps/web/src/__tests__/app-flows.test.tsx apps/web/tests/app-flows.test.tsx
git mv apps/web/src/api/__tests__/*.test.ts apps/web/tests/api/
git mv apps/web/src/chat/__tests__/*.test.ts apps/web/tests/chat/
git mv apps/web/src/components/__tests__/*.test.tsx apps/web/tests/components/
git mv apps/web/src/test/setup.ts apps/web/tests/setup.ts
rmdir apps/web/src/__tests__ apps/web/src/api/__tests__ apps/web/src/chat/__tests__ apps/web/src/components/__tests__ apps/web/src/test
```

Expected:

- No web `*.test.ts` or `*.test.tsx` files remain under `apps/web/src/`.
- `apps/web/src/test/` is empty and can be removed.

- [ ] **Step 2: Update web relative imports**

Apply these import path rules:

```text
apps/web/tests/App.test.tsx
  ./App.js -> ../src/App.js

apps/web/tests/app-flows.test.tsx
  ../App.js -> ../src/App.js

apps/web/tests/api/*.test.ts
  ../<module>.js -> ../../src/api/<module>.js

apps/web/tests/chat/*.test.ts
  ../<module>.js -> ../../src/chat/<module>.js
  ../../api/<module>.js -> ../../src/api/<module>.js

apps/web/tests/components/*.test.tsx
  ../<Component>.js -> ../../src/components/<Component>.js
  ../../chat/<module>.js -> ../../src/chat/<module>.js
  ../../api/<module>.js -> ../../src/api/<module>.js
```

After editing, run:

```bash
rg -n "from ['\"]\\.\\.?/|vi\\.mock\\(['\"]\\.\\.?/" apps/web/tests
```

Expected:

- Relative source imports point into `../src/` or `../../src/`.

- [ ] **Step 3: Update web Vitest config**

Edit `apps/web/vitest.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
  },
});
```

- [ ] **Step 4: Make web source tsconfig source-focused**

Edit `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "declaration": false,
    "noEmit": true
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 5: Add web test tsconfig**

Create `apps/web/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "tests/**/*.ts", "tests/**/*.tsx", "vitest.config.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 6: Update web typecheck script**

Edit `apps/web/package.json`:

```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit"
  }
}
```

Only change the `typecheck` script. Keep other scripts unchanged.

- [ ] **Step 7: Verify web migration**

Run:

```bash
pnpm --filter @lance-agent-runner/web test
pnpm --filter @lance-agent-runner/web typecheck
pnpm --filter @lance-agent-runner/web build
find apps/web/src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \)
```

Expected:

- Tests, typecheck, and build PASS.
- The final `find` command prints no files.

## Task 4: Migrate RPA Local Web Tests

**Files:**

- Move: `apps/rpa-local-web/src/**/*.test.ts`
- Move: `apps/rpa-local-web/src/**/*.test.tsx`
- Move: `apps/rpa-local-web/src/test/setup.ts`
- Create: `apps/rpa-local-web/tsconfig.test.json`
- Modify: `apps/rpa-local-web/vitest.config.ts`
- Modify: `apps/rpa-local-web/tsconfig.json`
- Modify: `apps/rpa-local-web/tsconfig.server.test.json`
- Modify: `apps/rpa-local-web/package.json`

- [ ] **Step 1: Move RPA Web test files and setup**

Run:

```bash
mkdir -p apps/rpa-local-web/tests/api apps/rpa-local-web/tests/server/executor apps/rpa-local-web/tests/server/routes apps/rpa-local-web/tests/server/validators apps/rpa-local-web/tests/shared
git mv apps/rpa-local-web/src/App.test.tsx apps/rpa-local-web/tests/App.test.tsx
git mv apps/rpa-local-web/src/api/*.test.ts apps/rpa-local-web/tests/api/
git mv apps/rpa-local-web/src/server/*.test.ts apps/rpa-local-web/tests/server/
git mv apps/rpa-local-web/src/server/executor/*.test.ts apps/rpa-local-web/tests/server/executor/
git mv apps/rpa-local-web/src/server/routes/*.test.ts apps/rpa-local-web/tests/server/routes/
git mv apps/rpa-local-web/src/server/validators/*.test.ts apps/rpa-local-web/tests/server/validators/
git mv apps/rpa-local-web/src/shared/*.test.ts apps/rpa-local-web/tests/shared/
git mv apps/rpa-local-web/src/test/setup.ts apps/rpa-local-web/tests/setup.ts
rmdir apps/rpa-local-web/src/test
```

Expected:

- No RPA Web `*.test.ts` or `*.test.tsx` files remain under `apps/rpa-local-web/src/`.
- `apps/rpa-local-web/src/test/` is empty and can be removed.

- [ ] **Step 2: Update RPA Web relative imports**

Apply these import path rules:

```text
apps/rpa-local-web/tests/App.test.tsx
  ./App.js -> ../src/App.js

apps/rpa-local-web/tests/api/*.test.ts
  ./<module>.js -> ../../src/api/<module>.js

apps/rpa-local-web/tests/shared/*.test.ts
  ./<module>.js -> ../../src/shared/<module>.js

apps/rpa-local-web/tests/server/*.test.ts
  ./<module>.js -> ../../src/server/<module>.js
  ../shared/<module>.js -> ../../src/shared/<module>.js

apps/rpa-local-web/tests/server/validators/*.test.ts
  ./<module>.js -> ../../../src/server/validators/<module>.js
  ../../shared/<module>.js -> ../../../src/shared/<module>.js

apps/rpa-local-web/tests/server/executor/*.test.ts
  ./<module>.js -> ../../../src/server/executor/<module>.js
  ../../shared/<module>.js -> ../../../src/shared/<module>.js

apps/rpa-local-web/tests/server/routes/*.test.ts
  ../server.js -> ../../../src/server/server.js
  ../../shared/<module>.js -> ../../../src/shared/<module>.js
```

After editing, run:

```bash
rg -n "from ['\"]\\.\\.?/|vi\\.mock\\(['\"]\\.\\.?/" apps/rpa-local-web/tests
```

Expected:

- Relative source imports point into `../src/`, `../../src/`, or `../../../src/`.

- [ ] **Step 3: Update RPA Web Vitest config**

Edit `apps/rpa-local-web/vitest.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
  },
});
```

- [ ] **Step 4: Make RPA Web browser tsconfig source-focused**

Edit `apps/rpa-local-web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "declaration": false,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts", "vitest.config.ts"],
  "exclude": ["dist", "node_modules", "src/server", "tests"]
}
```

- [ ] **Step 5: Add RPA Web browser test tsconfig**

Create `apps/rpa-local-web/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "tests/App.test.tsx",
    "tests/api/**/*.test.ts",
    "tests/setup.ts",
    "vitest.config.ts"
  ],
  "exclude": ["dist", "node_modules", "src/server"]
}
```

- [ ] **Step 6: Update RPA Web server test tsconfig**

Edit `apps/rpa-local-web/tsconfig.server.test.json`:

```json
{
  "extends": "./tsconfig.server.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/server/**/*.ts", "src/shared/**/*.ts", "tests/server/**/*.test.ts", "tests/shared/**/*.test.ts"],
  "exclude": ["dist", "node_modules"]
}
```

The `rootDir: "."` override is required because this test config includes both `src/` and `tests/`.

- [ ] **Step 7: Update RPA Web typecheck script**

Edit `apps/rpa-local-web/package.json`:

```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.test.json --noEmit && tsc -p tsconfig.server.test.json --noEmit"
  }
}
```

Only change the `typecheck` script. Keep other scripts unchanged.

- [ ] **Step 8: Verify RPA Web migration**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
pnpm --filter @lance-agent-runner/rpa-local-web build
find apps/rpa-local-web/src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \)
```

Expected:

- Tests, typecheck, and build PASS.
- The final `find` command prints no files.

If RPA Web route/executor tests fail only because sandbox blocks local ports or nested child process output, rerun the same command outside sandbox before changing code.

## Task 5: Enforce And Document Source-Only Test Layout

**Files:**

- Modify: `apps/AGENTS.md`

- [ ] **Step 1: Update app test layout guidance**

Edit `apps/AGENTS.md` and replace the current Test Layout section with:

```markdown
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
```

- [ ] **Step 2: Add a source test guard command**

Run:

```bash
find apps -path '*/src/*' -type f \( -name '*.test.ts' -o -name '*.test.tsx' \)
```

Expected: no output.

Do not add a permanent script yet unless the user asks for enforcement in CI. For this migration, `apps/AGENTS.md` plus verification is enough.

## Task 6: Final Verification And Commit

**Files:**

- All moved test files.
- All modified app configs.
- `apps/AGENTS.md`.
- This plan document may be updated with completion notes after implementation.

- [ ] **Step 1: Run app package verification**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon test
pnpm --filter @lance-agent-runner/daemon typecheck
pnpm --filter @lance-agent-runner/daemon build
pnpm --filter @lance-agent-runner/web test
pnpm --filter @lance-agent-runner/web typecheck
pnpm --filter @lance-agent-runner/web build
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
pnpm --filter @lance-agent-runner/rpa-local-web build
```

Expected: PASS.

- [ ] **Step 2: Run root verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: PASS.

- [ ] **Step 3: Run layout guards**

Run:

```bash
find apps -path '*/src/*' -type f \( -name '*.test.ts' -o -name '*.test.tsx' \)
find apps -path '*/src/test' -type d
find apps -type d -name __tests__
```

Expected:

- All three commands print no files/directories.

- [ ] **Step 4: Review diff shape**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected:

- Diff is dominated by moved test files and config/doc updates.
- `git diff --check` passes.

- [ ] **Step 5: Request Claude Code review**

Ask Claude Code to review the migration before commit:

```text
Please review the current working tree for the App Tests Layout Migration.

Goal:
- Move app tests from apps/<app>/src/** into apps/<app>/tests/**.
- Keep src/ source-only.
- Preserve test behavior; this is not a feature slice.

Review focus:
1. Did any production behavior change accidentally?
2. Do Vitest configs include the new tests and exclude old src test locations?
3. Do TypeScript configs keep source and test typechecking clear?
4. Are relative imports after the move correct and maintainable?
5. Do apps/daemon, apps/web, and apps/rpa-local-web still pass test/typecheck/build?
6. Are there leftover *.test.ts(x), src/test, or __tests__ directories under src?
7. Is apps/AGENTS.md aligned with the new layout?

Expected output:
- P0/P1 blockers.
- P2 suggestions that can wait.
- Whether this migration is safe to commit.
```

- [ ] **Step 6: Commit migration**

After verification and review pass:

```bash
git add apps/daemon apps/web apps/rpa-local-web apps/AGENTS.md docs/superpowers/plans/2026-06-06-app-tests-layout-migration.md
git commit -m "Move app tests out of source directories"
```

## Acceptance Checklist

- [ ] No `*.test.ts` or `*.test.tsx` files remain under any `apps/<app>/src/` directory.
- [ ] No `apps/<app>/src/test/` directories remain.
- [ ] No `apps/<app>/src/**/__tests__/` directories remain.
- [ ] `apps/daemon/tests/**` contains all daemon tests.
- [ ] `apps/web/tests/**` contains all web tests and `tests/setup.ts`.
- [ ] `apps/rpa-local-web/tests/**` contains all RPA Web tests and `tests/setup.ts`.
- [ ] `apps/daemon/vitest.config.ts` includes `tests/**/*.test.ts`.
- [ ] `apps/web/vitest.config.ts` includes `tests/**/*.test.ts(x)` and uses `tests/setup.ts`.
- [ ] `apps/rpa-local-web/vitest.config.ts` includes `tests/**/*.test.ts(x)` and uses `tests/setup.ts`.
- [ ] App source TypeScript configs no longer need Vitest/testing-library globals.
- [ ] Test TypeScript configs typecheck tests explicitly.
- [ ] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.
- [ ] `apps/AGENTS.md` documents `apps/<app>/tests/` as the normative layout.

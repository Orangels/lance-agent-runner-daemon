# Monorepo Web Test Console Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the standalone daemon repository into a full `apps/daemon` + `apps/web` monorepo and add the foundation for a browser-based daemon test console.

**Architecture:** The daemon becomes an independent workspace package under `apps/daemon`; the web test console becomes a separate workspace package under `apps/web`. Runtime data remains repository-level under `.claude-runner/`, while daemon-owned business skills move under `apps/daemon/skills/`. Config paths must remain portable across package working directories by resolving relative paths from a documented base instead of relying on accidental process cwd.

**Tech Stack:** pnpm workspaces, TypeScript ESM, Express, SQLite, Vitest, Vite, React, browser `fetch` and `ReadableStream`.

---

## Review Context

This plan is for CC review before implementation. Do not move code or install dependencies until the plan is approved.

The repository currently has:

- Root daemon package: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/`, `skills/`.
- Runtime/config skeleton: `.claude-runner/`.
- Existing docs and API contract under `docs/`.
- Current uncommitted local changes that must be handled intentionally before migration:
  - `.claude-runner/config.local.json`
  - `config.example.json`
  - `.omc/` is untracked and must not be staged.

Reference repository remains:

```text
/home/orangels/ls_dev/lanceDesign
```

Use it for structure comparison only. Do not import lanceDesign private source.

## Target Repository Layout

```text
.
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── AGENTS.md
├── CLAUDE.md
├── REFERENCE.md
├── config.example.json
├── .claude-runner/
│   ├── config.local.json
│   ├── data/
│   ├── uploads/
│   ├── workspaces/
│   └── profiles/
├── apps/
│   ├── daemon/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── src/
│   │   └── skills/
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       └── src/
└── docs/
```

## Non-Goals

- Do not add production authentication UI to `apps/web`.
- Do not add business-specific lqBot product logic to daemon core modules.
- Do not change the daemon HTTP API contract unless a task below explicitly says so.
- Do not change `/api/runs` from single `skillId` to multi-skill in this migration.
- Do not move `.claude-runner/` under `apps/daemon/`.
- Do not commit runtime SQLite files, uploaded files, generated workspaces, logs, or `.omc/`.
- Do not add a `run_events` table.
- Do not import lanceDesign private source.

## Path Resolution Decision

Full monorepo changes the process cwd depending on how commands are launched:

- Root command: cwd is repository root.
- `pnpm --filter @...` script: cwd is usually the package directory.

Therefore daemon config must not rely on process cwd for relative runtime paths. The implementation must make this explicit:

- `loadDaemonConfig(configPath)` should resolve relative filesystem paths against the config file directory.
- `.claude-runner/config.local.json` must then use paths relative to `.claude-runner/`, for example:

```json
{
  "server": {
    "dataDir": "data"
  },
  "profiles": [
    {
      "sandboxRoot": "workspaces/report-docx",
      "claudeConfigDir": "profiles/report-docx/claude",
      "skillRoots": ["../apps/daemon/skills"],
      "allowedInputRoots": ["uploads"]
    }
  ]
}
```

- `config.example.json` may remain at repository root, but must clearly document that relative paths are resolved from the file location. Its sample paths should be correct when loaded from the root.

This is a behavior change and needs tests.

## Browser Authentication Decision

The web console must not use native `EventSource` for authenticated run events because browser `EventSource` cannot set `Authorization` or `x-api-key` headers. Do not add `?apiKey=` query authentication to daemon routes for this migration; API keys in URLs are easy to leak through browser history, proxies, and access logs.

Use these browser-side strategies instead:

- JSON routes: `fetch()` with `Authorization: Bearer <apiKey>`.
- SSE routes: `fetch()` with `Authorization` and parse the `text/event-stream` body with `ReadableStream`.
- Artifact downloads: `fetch()` with `Authorization`, convert the response to `Blob`, create an object URL, click a temporary `<a download>`, then revoke the URL.
- Logs: regular authenticated `fetch()`.

The first web commit only needs the profiles smoke path plus reusable authenticated client helpers. Full generate/revise/artifact/log workflows belong in a follow-up web-console plan after the monorepo migration is stable.

Daemon SSE frames use the SSE event name `agent` for all run events. The semantic event kind is inside `data.type`; UI code must treat `data.type === 'end'` as the terminal marker rather than waiting for an SSE event named `end`.

---

## File Responsibility Map

### Root Files

- `pnpm-workspace.yaml`: declares `apps/*` packages.
- `package.json`: workspace orchestration scripts only; no daemon runtime dependencies after migration.
- `tsconfig.base.json`: shared TypeScript compiler defaults.
- `.gitignore`: ignores `apps/*/dist`, web build artifacts, and runtime `.claude-runner` contents while keeping tracked skeleton files.
- `AGENTS.md`: updates repository shape and commands.
- `config.example.json`: example daemon config, still repository-level.

### Daemon Package

- `apps/daemon/package.json`: daemon name, scripts, daemon dependencies.
- `apps/daemon/tsconfig.json`: daemon TypeScript build config.
- `apps/daemon/vitest.config.ts`: daemon test config.
- `apps/daemon/src/**`: moved daemon implementation.
- `apps/daemon/skills/**`: daemon-managed business entry skills such as `report-gen`.

### Web Package

- `apps/web/package.json`: web test console scripts and dependencies.
- `apps/web/vite.config.ts`: dev server and `/api` proxy to daemon.
- `apps/web/src/api/daemon-client.ts`: typed browser client for daemon APIs.
- `apps/web/src/api/sse-stream.ts`: authenticated `fetch` + `ReadableStream` parser for run events.
- `apps/web/src/api/download.ts`: authenticated artifact download helper using `Blob` object URLs.
- `apps/web/src/App.tsx`: test console shell.
- `apps/web/src/main.tsx`: React entry point.
- `apps/web/src/styles.css`: restrained operational UI styles.

---

## Task 0: Preflight Current Local Changes

**Files:**

- Inspect only: `.claude-runner/config.local.json`
- Inspect only: `config.example.json`
- Inspect only: `.omc/`

- [ ] **Step 1: Inspect current local diff**

Run:

```bash
git status --short
git diff -- .claude-runner/config.local.json config.example.json
```

Expected known local config choices to preserve during migration:

```text
.claude-runner/config.local.json:
- server.globalConcurrency is 50
- clients[0].canReadDebugEvents is true
- profiles[0].defaultModel is "opus"

config.example.json:
- profiles[0].defaultModel is "opus"
```

If additional config differences appear, stop and ask the user whether to preserve them.

- [ ] **Step 2: Confirm `.omc/` remains outside Git**

Run:

```bash
git status --short .omc
```

Expected:

```text
?? .omc/
```

Do not stage `.omc/`.

- [ ] **Step 3: Carry these values through later config edits**

When Task 2 updates paths, preserve all non-path fields exactly, including:

```json
{
  "server": {
    "globalConcurrency": 50
  },
  "clients": [
    {
      "canReadDebugEvents": true
    }
  ],
  "profiles": [
    {
      "defaultModel": "opus"
    }
  ]
}
```

Do not create a commit in this task.

---

## Task 1: Create Workspace Boundaries and Move Daemon

**Files:**

- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Modify: `package.json`
- Create: `apps/daemon/package.json`
- Create: `apps/daemon/tsconfig.json`
- Create: `apps/daemon/vitest.config.ts`
- Move: `src/` -> `apps/daemon/src/`
- Move: `skills/` -> `apps/daemon/skills/`
- Delete: root `tsconfig.json`
- Delete: root `vitest.config.ts`
- Modify: `.gitignore`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md` if it mentions root `src/`

- [ ] **Step 1: Write the workspace file**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
```

- [ ] **Step 2: Create shared TypeScript base config**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 3: Convert root package to workspace orchestrator**

Modify root `package.json`:

```json
{
  "name": "lance-agent-runner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Standalone Claude Code CLI runner daemon and local test console.",
  "license": "UNLICENSED",
  "packageManager": "pnpm@10.33.2",
  "engines": {
    "node": "~24",
    "pnpm": ">=10.33.2 <11"
  },
  "scripts": {
    "dev": "pnpm dev:daemon",
    "dev:daemon": "pnpm --filter @lance-agent-runner/daemon dev",
    "start": "pnpm start:daemon",
    "build": "pnpm build:daemon",
    "build:daemon": "pnpm --filter @lance-agent-runner/daemon build",
    "test": "pnpm test:daemon",
    "test:daemon": "pnpm --filter @lance-agent-runner/daemon test",
    "typecheck": "pnpm typecheck:daemon",
    "typecheck:daemon": "pnpm --filter @lance-agent-runner/daemon typecheck",
    "start:daemon": "pnpm --filter @lance-agent-runner/daemon start",
    "start:daemon:local": "pnpm --filter @lance-agent-runner/daemon start:local"
  }
}
```

Keep `dev` and `start` aliases for migration-period compatibility with existing docs and operator muscle memory. Add web scripts only in Task 4 after `@lance-agent-runner/web` exists. Do not add a concurrent root dev script in this task.

- [ ] **Step 4: Create daemon package file**

Create `apps/daemon/package.json` by moving the current daemon dependencies and scripts:

```json
{
  "name": "@lance-agent-runner/daemon",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Standalone Claude Code CLI runner daemon for workspace-based agent tasks.",
  "license": "UNLICENSED",
  "scripts": {
    "dev": "tsx watch src/index.ts --config ../../.claude-runner/config.local.json",
    "start": "node dist/index.js",
    "start:local": "node dist/index.js --config ../../.claude-runner/config.local.json",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "chokidar": "^5.0.0",
    "express": "^5.2.1",
    "fast-glob": "^3.3.3",
    "multer": "^2.1.1",
    "prom-client": "^15.1.3",
    "undici": "^8.3.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/express": "^5.0.6",
    "@types/multer": "^2.1.0",
    "@types/node": "^20.17.10",
    "tsx": "4.21.0",
    "typescript": "^5.6.3",
    "vitest": "^4.1.7"
  }
}
```

`dev` and `start:local` may bind to the tracked local test config. `start` must not bind to `.claude-runner/config.local.json`; production-style starts should use `--config <path>` or `CLAUDE_RUNNER_CONFIG`.

- [ ] **Step 5: Create daemon tsconfig**

Create `apps/daemon/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "src/**/*.test.ts", "src/**/__tests__/**"]
}
```

- [ ] **Step 6: Create daemon vitest config**

Create `apps/daemon/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
```

- [ ] **Step 7: Move source tree before verification**

Run:

```bash
mkdir -p apps/daemon
git mv src apps/daemon/src
git mv skills apps/daemon/skills
```

This task intentionally moves source before the first commit so the first monorepo commit is buildable.

- [ ] **Step 8: Remove obsolete root TypeScript configs**

Run:

```bash
git rm tsconfig.json vitest.config.ts
```

- [ ] **Step 9: Update `.gitignore`**

Modify `.gitignore` so build outputs are ignored in package locations:

```gitignore
node_modules/
dist/
apps/*/dist/
apps/*/.vite/
*.tsbuildinfo

# Runtime data
.claude-runner/data/*
!.claude-runner/data/.gitkeep
.claude-runner/uploads/*
!.claude-runner/uploads/.gitkeep
.claude-runner/workspaces/*
!.claude-runner/workspaces/.gitkeep
!.claude-runner/workspaces/report-docx/
!.claude-runner/workspaces/report-docx/.gitkeep
.claude-runner/profiles/*/claude/*
!.claude-runner/profiles/report-docx/
!.claude-runner/profiles/report-docx/claude/
!.claude-runner/profiles/report-docx/claude/.gitkeep
sandboxes/
logs/
runs/
artifacts/

# Local environment
.env
.env.*
!.env.example

# Logs and OS/editor
npm-debug.log*
pnpm-debug.log*
.DS_Store
Thumbs.db
.idea/
.vscode/
```

- [ ] **Step 10: Update `AGENTS.md` project shape**

Replace the source layout section with:

```text
apps/
  daemon/
    src/
      config/
      core/
      db/
      http/
      index.ts
    skills/
  web/
    src/
docs/
REFERENCE.md
AGENTS.md
CLAUDE.md
package.json
pnpm-workspace.yaml
tsconfig.base.json
```

Also update coding standards references:

```text
- `apps/daemon/src/http/*` handles Express routing only.
- `apps/daemon/src/core/*` contains runner/domain logic and must not depend on Express.
- `apps/daemon/src/db/*` owns SQLite schema and repositories.
- `apps/daemon/src/config/*` owns config, profile, auth, and env validation.
```

- [ ] **Step 11: Install workspace dependencies and update lockfile**

Run:

```bash
pnpm install
```

Expected:

```text
Lockfile is up to date or updated successfully
```

This step must run before any `pnpm --filter ...` verification because workspace package links and native dependencies such as `better-sqlite3` need to be installed for the new layout.

- [ ] **Step 12: Verify workspace package discovery**

Run:

```bash
pnpm -r list --depth -1
```

Expected:

```text
@lance-agent-runner/daemon
```

`@lance-agent-runner/web` appears after Task 4.

- [ ] **Step 13: Verify daemon package is buildable**

Run:

```bash
pnpm typecheck:daemon
pnpm build:daemon
pnpm test:daemon
```

Expected:

```text
No TypeScript errors
daemon build succeeds
daemon tests pass
```

- [ ] **Step 14: Commit**

```bash
git add pnpm-workspace.yaml tsconfig.base.json package.json apps/daemon .gitignore AGENTS.md CLAUDE.md pnpm-lock.yaml
git add -u src skills tsconfig.json vitest.config.ts
git commit -m "chore: move daemon into monorepo workspace"
```

---

## Task 2: Make Config Paths Monorepo-Safe

**Files:**

- Modify: `apps/daemon/src/config/config.ts`
- Test: `apps/daemon/src/config/__tests__/config.test.ts`
- Modify: `.claude-runner/config.local.json`
- Modify: `config.example.json`
- Modify: `docs/configuration-reference.md`

- [ ] **Step 1: Add failing config-path test**

Create `apps/daemon/src/config/__tests__/config.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDaemonConfig } from '../config.js';

describe('loadDaemonConfig', () => {
  it('resolves relative filesystem paths from the config file directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'runner-config-base-test-'));
    const configDir = path.join(root, '.claude-runner');
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.local.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        server: {
          host: '127.0.0.1',
          port: 17890,
          dataDir: 'data',
          globalConcurrency: 1,
          maxQueueSize: 10,
          logRetentionMs: 1000,
          maxLogBytesPerRun: 1000,
          maxUploadBytesPerFile: 1000,
          uploadTempRetentionMs: 1000
        },
        clients: [
          {
            id: 'client-a',
            apiKey: 'env:TEST_DAEMON_API_KEY',
            allowedProfileIds: ['report-docx']
          }
        ],
        profiles: [
          {
            id: 'report-docx',
            sandboxRoot: 'workspaces/report-docx',
            claudeConfigDir: 'profiles/report-docx/claude',
            claudeBin: 'claude',
            skillRoots: ['../apps/daemon/skills'],
            allowedInputRoots: ['uploads'],
            allowedSkillIds: ['report-gen'],
            artifactRules: [],
            defaultArtifactRuleIds: [],
            permissionMode: 'bypassPermissions',
            defaultModel: 'sonnet',
            allowedModels: ['sonnet'],
            eventVisibility: 'normal',
            profileConcurrency: 1,
            runTimeoutMs: 1000,
            inactivityTimeoutMs: 1000,
            cancelGraceMs: 1000,
            env: {}
          }
        ]
      }),
    );

    const config = loadDaemonConfig(configPath, {
      TEST_DAEMON_API_KEY: 'secret',
    });

    expect(config.server.dataDir).toBe(path.join(configDir, 'data'));
    expect(config.profiles[0]?.sandboxRoot).toBe(path.join(configDir, 'workspaces/report-docx'));
    expect(config.profiles[0]?.claudeConfigDir).toBe(path.join(configDir, 'profiles/report-docx/claude'));
    expect(config.profiles[0]?.skillRoots).toEqual([path.join(root, 'apps/daemon/skills')]);
    expect(config.profiles[0]?.allowedInputRoots).toEqual([path.join(configDir, 'uploads')]);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run src/config/__tests__/config.test.ts
```

Expected:

```text
FAIL src/config/__tests__/config.test.ts
```

The failure should show unresolved relative paths.

- [ ] **Step 3: Implement path normalization**

Modify `apps/daemon/src/config/config.ts`:

```ts
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseDaemonConfig, type DaemonConfig } from './profiles.js';

export function loadDaemonConfig(
  configPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DaemonConfig {
  const resolvedConfigPath = path.resolve(configPath);
  const raw = JSON.parse(readFileSync(resolvedConfigPath, 'utf8')) as unknown;
  return normalizeDaemonConfigPaths(
    parseDaemonConfig(raw, { env }),
    path.dirname(resolvedConfigPath),
  );
}

function normalizeDaemonConfigPaths(config: DaemonConfig, baseDir: string): DaemonConfig {
  return {
    ...config,
    server: {
      ...config.server,
      dataDir: resolveConfigPath(baseDir, config.server.dataDir),
    },
    profiles: config.profiles.map((profile) => ({
      ...profile,
      sandboxRoot: resolveConfigPath(baseDir, profile.sandboxRoot),
      claudeConfigDir: resolveConfigPath(baseDir, profile.claudeConfigDir),
      skillRoots: profile.skillRoots.map((root) => resolveConfigPath(baseDir, root)),
      allowedInputRoots: profile.allowedInputRoots.map((root) => resolveConfigPath(baseDir, root)),
    })),
  };
}

function resolveConfigPath(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

export function getConfigPathFromArgs(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  const configFlagIndex = argv.indexOf('--config');
  if (configFlagIndex >= 0) {
    return argv[configFlagIndex + 1];
  }
  return env.CLAUDE_RUNNER_CONFIG;
}
```

- [ ] **Step 4: Update tracked local config path fields only**

Modify only these path fields in `.claude-runner/config.local.json` so they are relative to `.claude-runner/`:

```json
{
  "server": {
    "dataDir": "data"
  },
  "profiles": [
    {
      "sandboxRoot": "workspaces/report-docx",
      "claudeConfigDir": "profiles/report-docx/claude",
      "skillRoots": ["../apps/daemon/skills"],
      "allowedInputRoots": ["uploads"]
    }
  ]
}
```

Preserve all existing non-path fields exactly, including `clients`, `clients[0].canReadDebugEvents: true`, `artifactRules`, `env`, timeouts, `server.globalConcurrency: 50`, and `profiles[0].defaultModel: "opus"`. Do not replace the full file with the JSON fragment above.

- [ ] **Step 5: Update root example config path fields only**

Modify only these path fields in `config.example.json`:

```json
{
  "server": {
    "dataDir": ".claude-runner/data"
  },
  "profiles": [
    {
      "sandboxRoot": ".claude-runner/workspaces/report-docx",
      "claudeConfigDir": ".claude-runner/profiles/report-docx/claude",
      "skillRoots": ["apps/daemon/skills"],
      "allowedInputRoots": [".claude-runner/uploads"]
    }
  ]
}
```

Preserve all existing non-path fields exactly, including `profiles[0].defaultModel: "opus"`. Do not replace the full file with the JSON fragment above.

- [ ] **Step 6: Update configuration docs**

In `docs/configuration-reference.md`, add:

```md
Relative filesystem paths are resolved from the directory that contains the loaded config file, not from the shell working directory. For example, `.claude-runner/config.local.json` should use `data`, `uploads`, and `../apps/daemon/skills`, while root-level `config.example.json` can use `.claude-runner/data` and `apps/daemon/skills`.
```

- [ ] **Step 7: Verify config path test passes**

Run:

```bash
pnpm --filter @lance-agent-runner/daemon exec vitest run src/config/__tests__/config.test.ts
```

Expected:

```text
PASS src/config/__tests__/config.test.ts
```

- [ ] **Step 8: Verify daemon test/typecheck**

Run:

```bash
pnpm typecheck:daemon
pnpm test:daemon
```

Expected:

```text
No TypeScript errors
All daemon tests pass
```

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/config/config.ts apps/daemon/src/config/__tests__/config.test.ts .claude-runner/config.local.json config.example.json docs/configuration-reference.md
git commit -m "fix: resolve daemon config paths from config file"
```

---

## Task 3: Update Daemon Documentation Paths

**Files:**

- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `REFERENCE.md`
- Modify: `docs/api-reference.md`
- Modify: `docs/business-run-chat-integration-guide.md`
- Modify: `docs/claude-code-runner-daemon-version-roadmap.md`
- Optional modify: phase plan docs only if they describe current source layout rather than historical implementation plan.

- [ ] **Step 1: Replace current source path references**

For current-operational docs, replace:

```text
src/
src/http/*
src/core/*
src/db/*
src/config/*
skills/
```

with:

```text
apps/daemon/src/
apps/daemon/src/http/*
apps/daemon/src/core/*
apps/daemon/src/db/*
apps/daemon/src/config/*
apps/daemon/skills/
```

Do not rewrite historical phase plan task lists unless the text claims to describe the current repo layout. If a historical plan keeps old `src/` paths and appears likely to confuse implementation agents, add this note at the top of that historical document:

```md
> Historical note: file paths in this plan reflect the pre-monorepo layout. Current daemon source lives under `apps/daemon/src/`; see `AGENTS.md`.
```

- [ ] **Step 2: Add web test console section**

In `docs/claude-code-runner-daemon-version-roadmap.md`, add a first-version testing note:

```md
## First-Version Test Console

The first test UI lives under `apps/web`. It is a local daemon validation console, not a production business frontend. It may call local daemon APIs directly, display SSE events, upload/prepare files, create generate/revise runs, inspect artifacts, download outputs, and read logs for authorized clients.
```

- [ ] **Step 3: Run path reference grep**

Run:

```bash
rg "\bsrc/|skills/" AGENTS.md CLAUDE.md REFERENCE.md docs -n
rg "dist/index\.js|node dist|tsx src|pnpm (dev|start|build)" AGENTS.md CLAUDE.md REFERENCE.md docs -n
```

Expected:

- Historical phase plan references may remain.
- Current operational docs should point to `apps/daemon/src/` and `apps/daemon/skills/`.
- Historical phase plan command examples may remain if they are implementation snapshots.
- Current operational docs should use root aliases (`pnpm dev`, `pnpm start`, `pnpm build`) when the alias remains valid, or package-specific commands (`pnpm dev:daemon`, `pnpm start:daemon:local`, `node apps/daemon/dist/index.js`) when an explicit daemon path is required.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md CLAUDE.md REFERENCE.md docs
git commit -m "docs: update monorepo source layout"
```

---

## Task 4: Create Web Test Console Package Skeleton

**Files:**

- Modify: `package.json`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`

- [ ] **Step 1: Create web package**

Create `apps/web/package.json`:

```json
{
  "name": "@lance-agent-runner/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Local web test console for the Claude Code runner daemon.",
  "license": "UNLICENSED",
  "scripts": {
    "dev": "vite --host 127.0.0.1 --port 17891",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@types/node": "^20.17.10",
    "@types/react": "^19.2.8",
    "@types/react-dom": "^19.2.4",
    "@vitejs/plugin-react": "^5.1.1",
    "typescript": "^5.6.3",
    "vite": "^7.3.0",
    "vitest": "^4.1.7"
  }
}
```

- [ ] **Step 2: Add root web orchestration scripts**

Modify root `package.json` scripts to include web commands now that the package exists:

```json
{
  "scripts": {
    "dev": "pnpm dev:daemon",
    "dev:daemon": "pnpm --filter @lance-agent-runner/daemon dev",
    "dev:web": "pnpm --filter @lance-agent-runner/web dev",
    "start": "pnpm start:daemon",
    "build": "pnpm build:daemon && pnpm build:web",
    "build:daemon": "pnpm --filter @lance-agent-runner/daemon build",
    "build:web": "pnpm --filter @lance-agent-runner/web build",
    "test": "pnpm test:daemon && pnpm test:web",
    "test:daemon": "pnpm --filter @lance-agent-runner/daemon test",
    "test:web": "pnpm --filter @lance-agent-runner/web test",
    "typecheck": "pnpm typecheck:daemon && pnpm typecheck:web",
    "typecheck:daemon": "pnpm --filter @lance-agent-runner/daemon typecheck",
    "typecheck:web": "pnpm --filter @lance-agent-runner/web typecheck",
    "start:daemon": "pnpm --filter @lance-agent-runner/daemon start",
    "start:daemon:local": "pnpm --filter @lance-agent-runner/daemon start:local"
  }
}
```

- [ ] **Step 3: Create web tsconfig**

Create `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "allowImportingTsExtensions": false,
    "noEmit": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
}
```

- [ ] **Step 4: Create Vite config**

Create `apps/web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 17891,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:17890',
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 5: Create web Vitest config**

Create `apps/web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
});
```

- [ ] **Step 6: Create minimal HTML entry**

Create `apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Claude Runner Test Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Create minimal React entry**

Create `apps/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 8: Create placeholder console shell**

Create `apps/web/src/App.tsx`:

```tsx
export function App() {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Claude Runner Test Console</h1>
          <p>Local daemon integration surface for generate, revise, artifacts, and logs.</p>
        </div>
      </header>
      <section className="panel">
        <h2>Connection</h2>
        <p>Daemon API proxy target: http://127.0.0.1:17890</p>
      </section>
    </main>
  );
}
```

- [ ] **Step 9: Create base CSS**

Create `apps/web/src/styles.css`:

```css
:root {
  color: #1f2937;
  background: #f7f7f4;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

button,
input,
select,
textarea {
  font: inherit;
}

.shell {
  min-height: 100vh;
}

.topbar {
  border-bottom: 1px solid #d7d7d0;
  background: #ffffff;
  padding: 20px 28px;
}

.topbar h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
}

.topbar p {
  margin: 6px 0 0;
  color: #5f6673;
}

.panel {
  margin: 24px 28px;
  max-width: 760px;
  border: 1px solid #d7d7d0;
  background: #ffffff;
  padding: 20px;
  border-radius: 8px;
}

.panel h2 {
  margin: 0 0 8px;
  font-size: 16px;
}

.panel p {
  margin: 0;
  color: #4b5563;
}
```

- [ ] **Step 10: Install/update lockfile**

Run:

```bash
pnpm install
```

Expected:

```text
Lockfile is up to date or updated successfully
```

- [ ] **Step 11: Verify web skeleton**

Run:

```bash
pnpm typecheck:web
pnpm build:web
pnpm test:web
```

Expected:

```text
No TypeScript errors
Vite build succeeds
No web tests found and Vitest exits successfully because `passWithNoTests` is true
```

- [ ] **Step 12: Commit**

```bash
git add apps/web package.json pnpm-lock.yaml
git commit -m "chore: add web test console package"
```

---

## Task 5: Add Web API Client and Smoke Test

**Files:**

- Create: `apps/web/src/api/daemon-client.ts`
- Create: `apps/web/src/api/sse-stream.ts`
- Create: `apps/web/src/api/download.ts`
- Create: `apps/web/src/api/__tests__/daemon-client.test.ts`
- Create: `apps/web/src/api/__tests__/sse-stream.test.ts`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create typed daemon client**

Create `apps/web/src/api/daemon-client.ts`:

```ts
export interface ApiClientOptions {
  baseUrl?: string;
  apiKey: string;
}

export interface HealthResponse {
  ok: boolean;
}

export interface PublicProfile {
  id: string;
  allowedSkillIds: string[];
  defaultModel: string;
  allowedModels: string[];
  eventVisibility: 'quiet' | 'normal' | 'debug';
}

export interface ProfilesResponse {
  profiles: PublicProfile[];
}

interface RequestOptions extends RequestInit {
  auth?: boolean;
}

export function createDaemonClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl ?? '';

  async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const { auth = true, headers, ...requestInit } = init;
    const response = await fetch(`${baseUrl}${path}`, {
      ...requestInit,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        ...(headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Daemon request failed: ${response.status} ${body}`);
    }

    return (await response.json()) as T;
  }

  return {
    health: () => request<HealthResponse>('/api/health', { auth: false }),
    profiles: () => request<ProfilesResponse>('/api/profiles'),
  };
}
```

- [ ] **Step 2: Create authenticated SSE fetch helper**

Create `apps/web/src/api/sse-stream.ts`:

```ts
export interface RunEvent {
  id: string;
  event: string;
  data: unknown;
}

export interface ConnectRunEventsInput {
  runId: string;
  apiKey: string;
  after?: string;
  signal?: AbortSignal;
  onEvent: (event: RunEvent) => void;
}

export async function connectRunEvents({
  runId,
  apiKey,
  after,
  signal,
  onEvent,
}: ConnectRunEventsInput): Promise<void> {
  const search = after ? `?after=${encodeURIComponent(after)}` : '';
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/events${search}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Run event stream failed: ${response.status}`);
  }

  await parseEventStream(response.body, onEvent);
}

export async function parseEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: RunEvent) => void,
): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      emitSseChunk(chunk, onEvent);
      boundary = buffer.indexOf('\n\n');
    }
  }

  if (buffer.trim().length > 0) {
    emitSseChunk(buffer, onEvent);
  }
}

function emitSseChunk(chunk: string, onEvent: (event: RunEvent) => void): void {
  let id = '';
  let event = 'message';
  const dataLines: string[] = [];

  for (const rawLine of chunk.split(/\r?\n/)) {
    if (rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator >= 0 ? rawLine.slice(0, separator) : rawLine;
    const rawValue = separator >= 0 ? rawLine.slice(separator + 1) : '';
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'id') id = value;
    if (field === 'event') event = value || 'message';
    if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return;
  onEvent({
    id,
    event,
    data: JSON.parse(dataLines.join('\n')) as unknown,
  });
}
```

- [ ] **Step 3: Create authenticated download helper**

Create `apps/web/src/api/download.ts`:

```ts
export interface DownloadArtifactInput {
  runId: string;
  artifactId: string;
  apiKey: string;
}

export async function downloadArtifact({ runId, artifactId, apiKey }: DownloadArtifactInput): Promise<void> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Artifact download failed: ${response.status}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileNameFromDisposition(response.headers.get('Content-Disposition')) ?? artifactId;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function fileNameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const match = /filename="([^"]+)"/i.exec(disposition);
  return match?.[1] ?? null;
}
```

- [ ] **Step 4: Add client test**

Create `apps/web/src/api/__tests__/daemon-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonClient } from '../daemon-client';

describe('createDaemonClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends bearer auth to daemon endpoints', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ profiles: [] }), { status: 200 }));

    const client = createDaemonClient({ apiKey: 'secret' });
    await client.profiles();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/profiles',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
        }),
      }),
    );
  });
});
```

- [ ] **Step 5: Add SSE parser test**

Create `apps/web/src/api/__tests__/sse-stream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseEventStream } from '../sse-stream';

describe('parseEventStream', () => {
  it('parses id, event, and JSON data chunks from an SSE stream', async () => {
    const events: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('id: 7\nevent: agent\ndata: {"type":"status","label":"running"}\n\n'),
        );
        controller.close();
      },
    });

    await parseEventStream(stream, (event) => events.push(event));

    expect(events).toEqual([
      {
        id: '7',
        event: 'agent',
        data: { type: 'status', label: 'running' },
      },
    ]);
  });
});
```

- [ ] **Step 6: Wire a minimal profile loader UI**

Modify `apps/web/src/App.tsx`:

```tsx
import { useState } from 'react';
import { createDaemonClient, type PublicProfile } from './api/daemon-client';

export function App() {
  const [apiKey, setApiKey] = useState('');
  const [profiles, setProfiles] = useState<PublicProfile[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function loadProfiles() {
    setError(null);
    try {
      const client = createDaemonClient({ apiKey });
      const response = await client.profiles();
      setProfiles(response.profiles);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Claude Runner Test Console</h1>
          <p>Local daemon integration surface for generate, revise, artifacts, and logs.</p>
        </div>
      </header>
      <section className="panel">
        <h2>Connection</h2>
        <label className="field">
          <span>API key</span>
          <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
        </label>
        <button type="button" onClick={() => void loadProfiles()}>
          Load profiles
        </button>
        {error ? <p className="error">{error}</p> : null}
        <ul>
          {profiles.map((profile) => (
            <li key={profile.id}>
              {profile.id} · skills: {profile.allowedSkillIds.join(', ') || 'none'}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
```

- [ ] **Step 7: Add CSS for controls**

Append to `apps/web/src/styles.css`:

```css
.field {
  display: grid;
  gap: 6px;
  margin: 14px 0;
  max-width: 420px;
}

.field span {
  color: #374151;
  font-size: 13px;
  font-weight: 600;
}

.field input {
  border: 1px solid #c9c9c2;
  border-radius: 6px;
  padding: 9px 10px;
}

button {
  border: 1px solid #1f2937;
  border-radius: 6px;
  background: #1f2937;
  color: #ffffff;
  cursor: pointer;
  padding: 9px 12px;
}

.error {
  color: #b42318;
  margin-top: 12px;
}
```

- [ ] **Step 8: Verify web tests**

Run:

```bash
pnpm test:web
pnpm typecheck:web
pnpm build:web
```

Expected:

```text
PASS src/api/__tests__/daemon-client.test.ts
PASS src/api/__tests__/sse-stream.test.ts
No TypeScript errors
Vite build succeeds
```

- [ ] **Step 9: Commit**

```bash
git add apps/web/src
git commit -m "feat: add daemon web client shell"
```

---

## Task 6: End-to-End Monorepo Verification

**Files:**

- Modify only if needed: docs or package scripts.

- [ ] **Step 1: Run full static validation**

Run:

```bash
pnpm typecheck
pnpm build
pnpm test
```

Expected:

```text
daemon typecheck passes
web typecheck passes
daemon build passes
web build passes
daemon tests pass
web tests pass
```

- [ ] **Step 2: Start daemon**

Run:

```bash
CLAUDE_RUNNER_LQBOT_API_KEY=local-test pnpm dev:daemon
```

Expected:

```text
daemon listening on 127.0.0.1:17890
```

Leave this session running for Step 3.

- [ ] **Step 3: Start web console**

In a second shell, run:

```bash
pnpm dev:web
```

Expected:

```text
Local: http://127.0.0.1:17891/
```

- [ ] **Step 4: Manual smoke**

Open:

```text
http://127.0.0.1:17891/
```

Use API key:

```text
local-test
```

Click `Load profiles`.

Expected:

```text
report-docx · skills: report-gen
```

- [ ] **Step 5: Verify runtime paths use the repository-level `.claude-runner`**

With the daemon still running, in a third shell run:

```bash
test -d .claude-runner/data
test ! -e apps/daemon/.claude-runner
find .claude-runner/data -maxdepth 2 -type f | sort
```

Expected:

```text
The first two test commands exit 0.
The find command shows the repository-level SQLite database or data files created by the daemon.
No apps/daemon/.claude-runner directory exists.
```

This verifies the monorepo path contract end to end: relative config paths are resolved from `.claude-runner/config.local.json`, not from the daemon package cwd.

- [ ] **Step 6: Check git status**

Run:

```bash
git status --short
```

Expected:

```text
no tracked files modified except intentional changes
.omc/ remains untracked if present
```

- [ ] **Step 7: Commit any verification-only docs corrections**

If verification revealed docs-only corrections:

```bash
git add docs package.json apps/web apps/daemon
git commit -m "docs: clarify monorepo test workflow"
```

If no changes are needed, do not create an empty commit.

---

## Acceptance Criteria

- Root repository is a pnpm workspace with `apps/daemon` and `apps/web`.
- Daemon source lives under `apps/daemon/src`.
- Daemon business skills live under `apps/daemon/skills`.
- `.claude-runner/` remains repository-level runtime/config skeleton.
- Relative daemon config paths work regardless of whether daemon scripts are launched from root or package cwd.
- `pnpm typecheck`, `pnpm build`, and `pnpm test` pass from the root.
- `pnpm dev:daemon` starts the daemon with `.claude-runner/config.local.json`.
- `pnpm dev:web` starts the local web console.
- Web console can call `/api/profiles` through the Vite proxy using a manually entered API key.
- Web API helpers do not use native `EventSource`; run-event streaming uses authenticated `fetch` and artifact downloads use authenticated `fetch` plus `Blob` object URLs.
- No runtime data, SQLite DB, uploads, generated workspaces, logs, or `.omc/` are committed.

## CC Review Checklist

Ask CC to focus on:

- Whether resolving config paths from the config file directory is the right monorepo-safe contract.
- Whether `.claude-runner/config.local.json` should remain tracked after path normalization.
- Whether web should be React/Vite now or a smaller vanilla Vite app.
- Whether authenticated `fetch` streaming is the right browser-side SSE strategy, instead of adding query-token auth to daemon routes.
- Whether daemon dependencies should move fully into `apps/daemon/package.json` immediately.
- Whether root scripts should keep compatibility aliases such as `pnpm dev`, `pnpm start`, `pnpm typecheck`.
- Whether Task 4/5 should remain shell + profiles smoke + reusable authenticated helpers only, leaving upload/run/artifact/log workflows for the next web-console plan.

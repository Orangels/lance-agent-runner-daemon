# RPA Local Web Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the initial `apps/rpa-local-web` local B/S RPA application skeleton with a runnable backend, Vite React UI shell, typed daemon client, and smoke tests.

**Architecture:** `apps/rpa-local-web` is a product-layer app. It owns RPA UI/BFF concerns and calls the generic daemon over HTTP; daemon core must not import or understand RPA logic. The backend starts one local Express service, mounts `/api/rpa/*`, and serves the React app through Vite middleware in dev or static files in production.

**Tech Stack:** TypeScript ESM, React 19, Vite, Express 5, Vitest, Testing Library, Node built-in `fetch` / Web Streams APIs.

**Status:** Completed in commit `e75a5ef`.

---

## Scope Boundary

This slice only creates the RPA local web package skeleton.

It must include:

- A new pnpm workspace package: `@lance-agent-runner/rpa-local-web`.
- Root scripts for dev/build/test/typecheck.
- A local backend server that exposes `/api/rpa/*`.
- A typed daemon client covering workspace, upload, run create, cancel, SSE subscription, artifact list, and artifact download.
- A dense operational UI shell with tabs for codegen hardening, natural-language generation, flows, executions, and settings.
- Smoke tests for the daemon client, server routes, and UI shell.

It must not include:

- DSL v0.1 schema or validators.
- Python/Playwright executor.
- `.rpa.zip` import/export.
- Real codegen orchestration.
- Real natural-language generation workflow.
- Any changes that make `apps/daemon` understand RPA concepts.

## File Structure

Create:

```text
apps/rpa-local-web/
  index.html
  package.json
  tsconfig.json
  tsconfig.server.json
  tsconfig.server.test.json
  vite.config.ts
  vitest.config.ts
  src/
    App.test.tsx
    App.tsx
    main.tsx
    styles.css
    api/
      rpa-api-client.test.ts
      rpa-api-client.ts
    components/
      AppShell.tsx
      StatusBadge.tsx
    server/
      config.ts
      daemon-client.test.ts
      daemon-client.ts
      index.ts
      server.test.ts
      server.ts
    shared/
      daemon-types.ts
      rpa-api-types.ts
    test/
      setup.ts
```

Modify:

```text
package.json
docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md
```

Responsibilities:

- `src/server/index.ts`: CLI entrypoint for the local B/S server.
- `src/server/server.ts`: Express app factory, `/api/rpa/*` routes, Vite dev middleware, static production serving.
- `src/server/config.ts`: local server config from env and safe defaults.
- `src/server/daemon-client.ts`: server-side typed daemon HTTP/SSE client. This is the only first-slice backend integration point to daemon.
- `src/shared/daemon-types.ts`: daemon API request/response types copied as a stable local contract; do not import from `apps/web`.
- `src/shared/rpa-api-types.ts`: local RPA BFF response types.
- `src/api/rpa-api-client.ts`: browser-side typed client for local `/api/rpa/*`.
- `src/App.tsx` and `src/components/*`: product UI shell only.

## Task 1: Add Workspace Package And Root Scripts

**Files:**

- Create: `apps/rpa-local-web/package.json`
- Create: `apps/rpa-local-web/tsconfig.json`
- Create: `apps/rpa-local-web/tsconfig.server.json`
- Create: `apps/rpa-local-web/tsconfig.server.test.json`
- Create: `apps/rpa-local-web/vite.config.ts`
- Create: `apps/rpa-local-web/vitest.config.ts`
- Create: `apps/rpa-local-web/index.html`
- Create: `apps/rpa-local-web/src/test/setup.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the package manifest**

Create `apps/rpa-local-web/package.json` with:

```json
{
  "name": "@lance-agent-runner/rpa-local-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Local B/S RPA MVP application for Claude Code generated Playwright flows.",
  "license": "UNLICENSED",
  "scripts": {
    "dev": "tsx watch src/server/index.ts",
    "start": "node dist/server/index.js",
    "build": "tsc -p tsconfig.server.json && vite build",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.server.test.json --noEmit"
  },
  "dependencies": {
    "express": "^5.2.1",
    "lucide-react": "^0.561.0",
    "react": "^19.2.3",
    "react-dom": "^19.2.3"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "@types/express": "^5.0.6",
    "@types/node": "^20.17.10",
    "@types/react": "^19.2.7",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.1",
    "jsdom": "^27.3.0",
    "tsx": "4.21.0",
    "typescript": "^5.6.3",
    "vite": "^8.0.14",
    "vitest": "^4.1.7"
  }
}
```

- [ ] **Step 2: Add TypeScript configs**

Create `apps/rpa-local-web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"],
    "declaration": false,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts", "vitest.config.ts"],
  "exclude": ["dist", "node_modules", "src/server"]
}
```

Create `apps/rpa-local-web/tsconfig.server.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/server/**/*.ts", "src/shared/**/*.ts"],
  "exclude": ["dist", "node_modules", "**/*.test.ts", "**/*.test.tsx"]
}
```

Create `apps/rpa-local-web/tsconfig.server.test.json`:

```json
{
  "extends": "./tsconfig.server.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/server/**/*.test.ts", "src/server/**/*.ts", "src/shared/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Add Vite and Vitest configs**

Create `apps/rpa-local-web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
  },
});
```

Create `apps/rpa-local-web/vitest.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
  },
});
```

- [ ] **Step 4: Add the HTML entrypoint and test setup**

Create `apps/rpa-local-web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RPA Local Web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/rpa-local-web/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 5: Add root scripts and aggregate checks**

Modify root `package.json` scripts so they include the new package:

```json
{
  "scripts": {
    "dev:rpa-local-web": "pnpm --filter @lance-agent-runner/rpa-local-web dev",
    "build": "pnpm build:daemon && pnpm build:web && pnpm build:rpa-local-web",
    "build:rpa-local-web": "pnpm --filter @lance-agent-runner/rpa-local-web build",
    "test": "pnpm test:daemon && pnpm test:web && pnpm test:rpa-local-web",
    "test:rpa-local-web": "pnpm --filter @lance-agent-runner/rpa-local-web test",
    "typecheck": "pnpm typecheck:daemon && pnpm typecheck:web && pnpm typecheck:rpa-local-web",
    "typecheck:rpa-local-web": "pnpm --filter @lance-agent-runner/rpa-local-web typecheck"
  }
}
```

Keep existing scripts unchanged and insert the new script names beside the existing `web` scripts.

- [ ] **Step 6: Install and sync workspace dependencies**

Run:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` includes the `apps/rpa-local-web` importer, workspace dependencies are linked, and there are no package install errors.

- [ ] **Step 7: Verify package discovery**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
```

Expected: It may fail because app/server files are not created yet, but pnpm must resolve the package name. If it says `No projects matched the filters`, fix workspace/package names before proceeding.

## Task 2: Add Shared API Types And Daemon Client

**Files:**

- Create: `apps/rpa-local-web/src/shared/daemon-types.ts`
- Create: `apps/rpa-local-web/src/server/daemon-client.ts`
- Create: `apps/rpa-local-web/src/server/daemon-client.test.ts`

- [ ] **Step 1: Add daemon contract types**

Create `apps/rpa-local-web/src/shared/daemon-types.ts`:

```ts
export type RunKind = 'generate' | 'revise';
export type PromptMode = 'legacy' | 'business-context' | 'daemon-composed';
export type CollectionMode = 'lite' | 'diagnostic' | 'review';
export type EventVisibility = 'quiet' | 'normal' | 'debug';

export interface HealthResponse {
  ok: true;
}

export interface CreateWorkspaceRequest {
  profileId: string;
  workspace: {
    originId: string;
    userId: string;
    projectId: string;
  };
  metadata?: Record<string, unknown>;
}

export interface PublicWorkspace {
  workspaceId: string;
  workspaceKey: string;
}

export interface UploadedWorkspaceFile {
  targetPath: string;
  size: number;
  originalName: string;
  mimeType: string | null;
}

export interface UploadWorkspaceFileResponse extends PublicWorkspace {
  file: UploadedWorkspaceFile;
}

export interface ContextPolicy {
  recentMessages?: number;
  maxMessageChars?: number;
  maxTotalChars?: number;
  includeRunWarnings?: boolean;
}

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
  contextPolicy?: ContextPolicy;
  skillId?: string;
  model?: string;
  artifactRuleIds?: string[];
  eventVisibility?: EventVisibility;
  metadata?: Record<string, unknown>;
}

export interface CreateRunResponse {
  runId: string;
  status: 'queued';
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface CancelRunResponse {
  ok: true;
}

export interface ArtifactSummary {
  id: string;
  runId: string;
  workspaceId: string;
  ruleId: string;
  role: 'primary' | 'supporting' | 'debug';
  relativePath: string;
  fileName: string;
  mimeType: string | null;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
}

export interface ArtifactsResponse {
  artifacts: ArtifactSummary[];
}

export interface DaemonRunEventRecord {
  id: string;
  event: unknown;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

- [ ] **Step 2: Write failing daemon client tests**

Create `apps/rpa-local-web/src/server/daemon-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { DaemonClient, DaemonClientError } from './daemon-client.js';

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('RPA daemon client', () => {
  it('creates runs with bearer auth and JSON body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        runId: 'run_1',
        status: 'queued',
        conversationId: 'conv_1',
        userMessageId: 'msg_user',
        assistantMessageId: 'msg_assistant',
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon.local/', apiKey: 'secret', fetchImpl });

    await expect(
      client.createRun({
        profileId: 'rpa-local',
        workspaceId: 'ws_1',
        kind: 'generate',
        promptMode: 'business-context',
        currentPrompt: 'Harden the uploaded codegen script.',
        skillId: 'playwright-rpa-harden',
      }),
    ).resolves.toMatchObject({ runId: 'run_1' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://daemon.local/api/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('"skillId":"playwright-rpa-harden"'),
      }),
    );
  });

  it('uploads workspace files using multipart form data', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        workspaceId: 'ws_1',
        workspaceKey: 'rpa/local/flow',
        file: {
          targetPath: 'input/flow.py',
          size: 12,
          originalName: 'flow.py',
          mimeType: 'text/x-python',
        },
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon.local', apiKey: 'secret', fetchImpl });
    const file = new File(['print(1)'], 'flow.py', { type: 'text/x-python' });

    await client.uploadWorkspaceFile({ workspaceId: 'ws_1', file, targetPath: 'input/flow.py' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://daemon.local/api/workspaces/ws_1/files',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: expect.any(FormData),
      }),
    );
  });

  it('cancels runs and lists artifacts', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ artifacts: [] }));
    const client = new DaemonClient({ baseUrl: 'http://daemon.local', apiKey: 'secret', fetchImpl });

    await expect(client.cancelRun('run_1')).resolves.toEqual({ ok: true });
    await expect(client.listRunArtifacts('run_1')).resolves.toEqual({ artifacts: [] });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://daemon.local/api/runs/run_1/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://daemon.local/api/runs/run_1/artifacts',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('parses SSE event records from daemon event streams', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`id: 1
event: message
data: {"type":"status","label":"running"}

`));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const client = new DaemonClient({ baseUrl: 'http://daemon.local', apiKey: 'secret', fetchImpl });

    const records = [];
    for await (const record of client.subscribeRunEvents('run_1')) {
      records.push(record);
    }

    expect(records).toEqual([
      {
        id: '1',
        event: { type: 'status', label: 'running' },
      },
    ]);
  });

  it('throws structured daemon errors', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } }, { status: 400 }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon.local', apiKey: 'secret', fetchImpl });

    await expect(client.createWorkspace({
      profileId: 'rpa-local',
      workspace: { originId: 'rpa', userId: 'local', projectId: 'flow' },
    })).rejects.toMatchObject({
      name: 'DaemonClientError',
      status: 400,
      code: 'BAD_REQUEST',
    });
  });
});
```

- [ ] **Step 3: Run the daemon client test to verify it fails**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run src/server/daemon-client.test.ts
```

Expected: FAIL because `src/server/daemon-client.ts` does not exist.

- [ ] **Step 4: Implement the daemon client**

Create `apps/rpa-local-web/src/server/daemon-client.ts`:

```ts
import type {
  ArtifactsResponse,
  CancelRunResponse,
  CreateRunRequest,
  CreateRunResponse,
  CreateWorkspaceRequest,
  DaemonRunEventRecord,
  ErrorResponse,
  HealthResponse,
  PublicWorkspace,
  UploadWorkspaceFileResponse,
} from '../shared/daemon-types.js';

type FetchLike = typeof fetch;

export interface DaemonClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
}

interface JsonRequestOptions {
  method?: string;
  body?: unknown;
}

export class DaemonClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DaemonClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: DaemonClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  getHealth(): Promise<HealthResponse> {
    return this.requestJson('/api/health');
  }

  createWorkspace(request: CreateWorkspaceRequest): Promise<PublicWorkspace> {
    return this.requestJson('/api/workspaces', { method: 'POST', body: request });
  }

  createRun(request: CreateRunRequest): Promise<CreateRunResponse> {
    return this.requestJson('/api/runs', { method: 'POST', body: request });
  }

  cancelRun(runId: string): Promise<CancelRunResponse> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
  }

  listRunArtifacts(runId: string): Promise<ArtifactsResponse> {
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
  }

  async uploadWorkspaceFile(input: {
    workspaceId: string;
    file: File | Blob;
    targetPath: string;
    fileName?: string;
  }): Promise<UploadWorkspaceFileResponse> {
    const formData = new FormData();
    formData.append('targetPath', input.targetPath);
    formData.append('file', input.file, input.fileName);

    const response = await this.fetchImpl(
      this.toUrl(`/api/workspaces/${encodeURIComponent(input.workspaceId)}/files`),
      {
        body: formData,
        headers: authHeaders(this.apiKey),
        method: 'POST',
      },
    );

    return parseJsonResponse<UploadWorkspaceFileResponse>(response);
  }

  async downloadArtifact(input: { runId: string; artifactId: string }): Promise<Response> {
    const response = await this.fetchImpl(
      this.toUrl(
        `/api/runs/${encodeURIComponent(input.runId)}/artifacts/${encodeURIComponent(input.artifactId)}/download`,
      ),
      {
        headers: authHeaders(this.apiKey),
        method: 'GET',
      },
    );
    if (!response.ok) {
      throw await toDaemonClientError(response);
    }
    return response;
  }

  async *subscribeRunEvents(runId: string, after?: string): AsyncGenerator<DaemonRunEventRecord> {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    const response = await this.fetchImpl(
      this.toUrl(`/api/runs/${encodeURIComponent(runId)}/events${query}`),
      {
        headers: authHeaders(this.apiKey),
        method: 'GET',
      },
    );
    if (!response.ok) {
      throw await toDaemonClientError(response);
    }
    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const parsed = parseSseRecord(chunk);
        if (parsed) yield parsed;
      }
    }

    buffer += decoder.decode();
    const parsed = parseSseRecord(buffer);
    if (parsed) yield parsed;
  }

  private requestJson<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = authHeaders(this.apiKey);
    const init: RequestInit = {
      headers,
      method: options.method ?? 'GET',
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    return this.fetchImpl(this.toUrl(path), init).then((response) => parseJsonResponse<T>(response));
  }

  private toUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await readJson(response);
  if (!response.ok) {
    throw toApiError(response, payload);
  }
  return payload as T;
}

async function toDaemonClientError(response: Response): Promise<DaemonClientError> {
  return toApiError(response, await readJson(response));
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toApiError(response: Response, payload: unknown): DaemonClientError {
  const structured = parseErrorResponse(payload);
  if (structured) {
    return new DaemonClientError(
      response.status,
      structured.error.code,
      structured.error.message,
      structured.error.details,
    );
  }
  return new DaemonClientError(response.status, 'HTTP_ERROR', response.statusText || `HTTP ${response.status}`);
}

function parseErrorResponse(payload: unknown): ErrorResponse | null {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return null;
  const error = (payload as { error: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return { error: { code, message, details } };
}

function parseSseRecord(chunk: string): DaemonRunEventRecord | null {
  const lines = chunk.split('\n');
  let id = '';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  const parsed = JSON.parse(data) as { event?: unknown };
  return { id, event: parsed.event ?? parsed };
}
```

- [ ] **Step 5: Run daemon client tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run src/server/daemon-client.test.ts
```

Expected: PASS.

## Task 3: Add Local BFF Server Skeleton

**Files:**

- Create: `apps/rpa-local-web/src/shared/rpa-api-types.ts`
- Create: `apps/rpa-local-web/src/server/config.ts`
- Create: `apps/rpa-local-web/src/server/server.ts`
- Create: `apps/rpa-local-web/src/server/index.ts`
- Create: `apps/rpa-local-web/src/server/server.test.ts`

- [ ] **Step 1: Add local API response types**

Create `apps/rpa-local-web/src/shared/rpa-api-types.ts`:

```ts
export interface RpaHealthResponse {
  ok: true;
  app: 'rpa-local-web';
}

export interface RpaConfigResponse {
  defaultProfileId: string;
  daemonConfigured: boolean;
}

export interface RpaDaemonHealthResponse {
  ok: boolean;
  daemonReachable: boolean;
  status?: number;
  error?: string;
}
```

- [ ] **Step 2: Add server config**

Create `apps/rpa-local-web/src/server/config.ts`:

```ts
export interface RpaLocalServerConfig {
  host: string;
  port: number;
  daemonBaseUrl: string;
  daemonApiKey: string;
  defaultProfileId: string;
  mode: 'development' | 'production' | 'test';
}

export function readRpaLocalServerConfig(env: NodeJS.ProcessEnv = process.env): RpaLocalServerConfig {
  return {
    host: env.RPA_LOCAL_HOST ?? '127.0.0.1',
    port: parsePort(env.RPA_LOCAL_PORT ?? '5174'),
    daemonBaseUrl: env.RPA_DAEMON_BASE_URL ?? 'http://127.0.0.1:17890',
    daemonApiKey: env.RPA_DAEMON_API_KEY ?? 'local-dev-key',
    defaultProfileId: env.RPA_DAEMON_PROFILE_ID ?? 'rpa-local',
    mode: env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development',
  };
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid RPA_LOCAL_PORT: ${value}`);
  }
  return parsed;
}
```

- [ ] **Step 3: Write failing server route tests**

Create `apps/rpa-local-web/src/server/server.test.ts`:

```ts
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRpaLocalServer } from './server.js';

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function withServer(callback: (baseUrl: string) => Promise<void>) {
  const app = await createRpaLocalServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      daemonBaseUrl: 'http://daemon.local',
      daemonApiKey: 'secret',
      defaultProfileId: 'rpa-local',
      mode: 'test',
    },
    daemonFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  });
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  await callback(`http://127.0.0.1:${port}`);
}

describe('RPA local server', () => {
  it('serves local RPA health and config without exposing daemon API key', async () => {
    await withServer(async (baseUrl) => {
      await expect(fetch(`${baseUrl}/api/rpa/health`).then((res) => res.json())).resolves.toEqual({
        ok: true,
        app: 'rpa-local-web',
      });

      const config = await fetch(`${baseUrl}/api/rpa/config`).then((res) => res.json());
      expect(config).toEqual({
        defaultProfileId: 'rpa-local',
        daemonConfigured: true,
      });
      expect(JSON.stringify(config)).not.toContain('secret');
      expect(JSON.stringify(config)).not.toContain('daemon.local');
    });
  });

  it('checks daemon health through the server-side daemon client', async () => {
    await withServer(async (baseUrl) => {
      await expect(fetch(`${baseUrl}/api/rpa/daemon/health`).then((res) => res.json())).resolves.toEqual({
        ok: true,
        daemonReachable: true,
        status: 200,
      });
    });
  });
});
```

- [ ] **Step 4: Run server tests to verify they fail**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run src/server/server.test.ts
```

Expected: FAIL because `src/server/server.ts` does not exist.

- [ ] **Step 5: Implement the Express app factory**

Create `apps/rpa-local-web/src/server/server.ts`:

```ts
import express, { type Express } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import { DaemonClient } from './daemon-client.js';
import type { RpaLocalServerConfig } from './config.js';
import type { RpaConfigResponse, RpaDaemonHealthResponse, RpaHealthResponse } from '../shared/rpa-api-types.js';

export interface CreateRpaLocalServerInput {
  config: RpaLocalServerConfig;
  daemonFetch?: typeof fetch;
}

export async function createRpaLocalServer(input: CreateRpaLocalServerInput): Promise<Express> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const daemonClient = new DaemonClient({
    baseUrl: input.config.daemonBaseUrl,
    apiKey: input.config.daemonApiKey,
    fetchImpl: input.daemonFetch,
  });

  app.get('/api/rpa/health', (_req, res) => {
    const payload: RpaHealthResponse = { ok: true, app: 'rpa-local-web' };
    res.json(payload);
  });

  app.get('/api/rpa/config', (_req, res) => {
    const payload: RpaConfigResponse = {
      defaultProfileId: input.config.defaultProfileId,
      daemonConfigured: input.config.daemonBaseUrl.trim().length > 0,
    };
    res.json(payload);
  });

  app.get('/api/rpa/daemon/health', async (_req, res) => {
    try {
      await daemonClient.getHealth();
      const payload: RpaDaemonHealthResponse = {
        ok: true,
        daemonReachable: true,
        status: 200,
      };
      res.json(payload);
    } catch (error) {
      const payload: RpaDaemonHealthResponse = {
        ok: false,
        daemonReachable: false,
        error: error instanceof Error ? sanitizeHealthError(error.message) : 'Unknown daemon health error',
      };
      res.status(502).json(payload);
    }
  });

  app.locals.daemonClient = daemonClient;

  if (input.config.mode === 'development') {
    const vite = await createViteMiddleware();
    app.use(vite.middlewares);
  } else if (input.config.mode === 'production') {
    const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
    app.use(express.static(clientDist));
    app.get('/*splat', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}

async function createViteMiddleware(): Promise<ViteDevServer> {
  const { createServer } = await import('vite');
  return createServer({
    appType: 'spa',
    server: { middlewareMode: true },
  });
}

function sanitizeHealthError(message: string): string {
  return message.replace(/https?:\/\/[^/\s]+/g, '[daemon]');
}
```

Note: `app.locals.daemonClient` is intentionally not exposed through the API. It exists so later RPA workflow routes can reuse the server-side daemon client without leaking the API key to the browser.

- [ ] **Step 6: Implement the server entrypoint**

Create `apps/rpa-local-web/src/server/index.ts`:

```ts
import { readRpaLocalServerConfig } from './config.js';
import { createRpaLocalServer } from './server.js';

const config = readRpaLocalServerConfig();
const app = await createRpaLocalServer({ config });

app.listen(config.port, config.host, () => {
  console.log(`RPA Local Web listening on http://${config.host}:${config.port}`);
});
```

- [ ] **Step 7: Run server tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run src/server/server.test.ts
```

Expected: PASS. If sandbox blocks `listen`, rerun with approved escalated permissions exactly as with daemon HTTP tests.

## Task 4: Add Browser API Client

**Files:**

- Create: `apps/rpa-local-web/src/api/rpa-api-client.ts`
- Create: `apps/rpa-local-web/src/api/rpa-api-client.test.ts`

- [ ] **Step 1: Write failing browser API client tests**

Create `apps/rpa-local-web/src/api/rpa-api-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RpaApiClient } from './rpa-api-client.js';

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('RPA browser API client', () => {
  it('reads local config from the RPA BFF', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ defaultProfileId: 'rpa-local', daemonConfigured: true }),
    );
    const client = new RpaApiClient({ fetchImpl });

    await expect(client.getConfig()).resolves.toEqual({
      defaultProfileId: 'rpa-local',
      daemonConfigured: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/rpa/config', expect.objectContaining({ method: 'GET' }));
  });
});
```

- [ ] **Step 2: Run the browser API client test to verify it fails**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run src/api/rpa-api-client.test.ts
```

Expected: FAIL because `rpa-api-client.ts` does not exist.

- [ ] **Step 3: Implement the browser API client**

Create `apps/rpa-local-web/src/api/rpa-api-client.ts`:

```ts
import type { RpaConfigResponse, RpaDaemonHealthResponse, RpaHealthResponse } from '../shared/rpa-api-types.js';

type FetchLike = typeof fetch;

export interface RpaApiClientOptions {
  fetchImpl?: FetchLike;
}

export class RpaApiClient {
  private readonly fetchImpl: FetchLike;

  constructor(options: RpaApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  getHealth(): Promise<RpaHealthResponse> {
    return this.requestJson('/api/rpa/health');
  }

  getConfig(): Promise<RpaConfigResponse> {
    return this.requestJson('/api/rpa/config');
  }

  getDaemonHealth(): Promise<RpaDaemonHealthResponse> {
    return this.requestJson('/api/rpa/daemon/health');
  }

  private async requestJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(path, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`RPA API request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}
```

- [ ] **Step 4: Run browser API client tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run src/api/rpa-api-client.test.ts
```

Expected: PASS.

## Task 5: Add Operational UI Shell

**Files:**

- Create: `apps/rpa-local-web/src/components/AppShell.tsx`
- Create: `apps/rpa-local-web/src/components/StatusBadge.tsx`
- Create: `apps/rpa-local-web/src/App.tsx`
- Create: `apps/rpa-local-web/src/App.test.tsx`
- Create: `apps/rpa-local-web/src/main.tsx`
- Create: `apps/rpa-local-web/src/styles.css`

- [ ] **Step 1: Write failing UI shell test**

Create `apps/rpa-local-web/src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('RPA local web app shell', () => {
  it('renders dense workflow navigation and switches sections', async () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'RPA Local Web' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Codegen 加固' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('上传 Playwright codegen 录制脚本')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '自然语言生成' }));

    expect(screen.getByRole('tab', { name: '自然语言生成' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('用业务描述生成 RPA 流程')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run UI test to verify it fails**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run src/App.test.tsx
```

Expected: FAIL because `App.tsx` does not exist.

- [ ] **Step 3: Add presentational components**

Create `apps/rpa-local-web/src/components/StatusBadge.tsx`:

```tsx
export interface StatusBadgeProps {
  tone: 'neutral' | 'ready' | 'warning';
  children: string;
}

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}
```

Create `apps/rpa-local-web/src/components/AppShell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Bot, Braces, FolderKanban, PlaySquare, Settings, WandSparkles } from 'lucide-react';
import { StatusBadge } from './StatusBadge.js';

export type RpaSectionId = 'codegen' | 'natural-language' | 'flows' | 'executions' | 'settings';

export interface RpaSection {
  id: RpaSectionId;
  label: string;
  title: string;
  description: string;
  icon: ReactNode;
}

export const rpaSections: RpaSection[] = [
  {
    id: 'codegen',
    label: 'Codegen 加固',
    title: '上传 Playwright codegen 录制脚本',
    description: '选择录制产物，交给 playwright-rpa-harden skill 生成 DSL、加固脚本和报告。',
    icon: <Braces aria-hidden="true" />,
  },
  {
    id: 'natural-language',
    label: '自然语言生成',
    title: '用业务描述生成 RPA 流程',
    description: '收集目标 URL、业务步骤和确认信息，交给 rpa-script-generate skill 生成可验证流程。',
    icon: <WandSparkles aria-hidden="true" />,
  },
  {
    id: 'flows',
    label: 'Flows',
    title: '流程资产',
    description: '后续展示已生成流程、参数表单、导入导出包和版本记录。',
    icon: <FolderKanban aria-hidden="true" />,
  },
  {
    id: 'executions',
    label: 'Executions',
    title: '执行与验证',
    description: '后续展示 verify/run 状态、步骤截图、日志、trace、录像和下载产物。',
    icon: <PlaySquare aria-hidden="true" />,
  },
  {
    id: 'settings',
    label: 'Settings',
    title: '本地配置',
    description: '后续配置 daemon 地址、profile、浏览器策略、下载目录和调试采集模式。',
    icon: <Settings aria-hidden="true" />,
  },
];

export interface AppShellProps {
  activeSectionId: RpaSectionId;
  onSectionChange: (sectionId: RpaSectionId) => void;
}

export function AppShell({ activeSectionId, onSectionChange }: AppShellProps) {
  const activeSection = rpaSections.find((section) => section.id === activeSectionId) ?? rpaSections[0]!;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>RPA Local Web</h1>
          <p>本地 B/S 形态的脚本生成、加固和执行工作台</p>
        </div>
        <div className="topbar__status">
          <StatusBadge tone="ready">Local</StatusBadge>
          <StatusBadge tone="neutral">Daemon</StatusBadge>
        </div>
      </header>

      <section className="workspace">
        <nav className="sidebar" aria-label="RPA workflows">
          <div className="sidebar__brand">
            <Bot aria-hidden="true" />
            <span>RPA MVP</span>
          </div>
          <div role="tablist" aria-label="RPA sections" className="section-tabs">
            {rpaSections.map((section) => (
              <button
                key={section.id}
                type="button"
                role="tab"
                aria-selected={section.id === activeSection.id}
                className="section-tab"
                onClick={() => onSectionChange(section.id)}
              >
                {section.icon}
                <span>{section.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <section className="content-panel" aria-labelledby="section-title">
          <div className="content-panel__heading">
            <div>
              <h2 id="section-title">{activeSection.title}</h2>
              <p>{activeSection.description}</p>
            </div>
            <StatusBadge tone="warning">Skeleton</StatusBadge>
          </div>

          <div className="placeholder-grid">
            <div className="placeholder-panel">
              <h3>输入</h3>
              <div className="placeholder-line" />
              <div className="placeholder-line placeholder-line--short" />
            </div>
            <div className="placeholder-panel">
              <h3>运行状态</h3>
              <div className="placeholder-line" />
              <div className="placeholder-line placeholder-line--short" />
            </div>
            <div className="placeholder-panel">
              <h3>产物</h3>
              <div className="placeholder-line" />
              <div className="placeholder-line placeholder-line--short" />
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Add App and entrypoint**

Create `apps/rpa-local-web/src/App.tsx`:

```tsx
import { useState } from 'react';
import { AppShell, type RpaSectionId } from './components/AppShell.js';
import './styles.css';

export function App() {
  const [activeSectionId, setActiveSectionId] = useState<RpaSectionId>('codegen');
  return <AppShell activeSectionId={activeSectionId} onSectionChange={setActiveSectionId} />;
}
```

Create `apps/rpa-local-web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 5: Add responsive operational styling**

Create `apps/rpa-local-web/src/styles.css`:

```css
:root {
  color: #1c2430;
  background: #eef2f6;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}

button {
  font: inherit;
}

.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.topbar {
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 24px;
  background: #f8fafc;
  border-bottom: 1px solid #d7dee8;
}

.topbar h1,
.content-panel h2,
.placeholder-panel h3 {
  margin: 0;
  letter-spacing: 0;
}

.topbar h1 {
  font-size: 20px;
  line-height: 1.2;
}

.topbar p,
.content-panel p {
  margin: 4px 0 0;
  color: #5b6677;
  font-size: 13px;
}

.topbar__status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.workspace {
  flex: 1;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  min-height: 0;
}

.sidebar {
  border-right: 1px solid #d7dee8;
  background: #ffffff;
  padding: 16px 12px;
}

.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 8px 12px;
  font-weight: 700;
  color: #263241;
}

.sidebar__brand svg,
.section-tab svg {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

.section-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section-tab {
  min-height: 38px;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #3a4656;
  text-align: left;
  cursor: pointer;
}

.section-tab[aria-selected="true"] {
  background: #e9f1ff;
  border-color: #b8cef5;
  color: #173b73;
}

.content-panel {
  padding: 24px;
  overflow: auto;
}

.content-panel__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.content-panel h2 {
  font-size: 22px;
  line-height: 1.25;
}

.placeholder-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.placeholder-panel {
  min-height: 140px;
  padding: 14px;
  border: 1px solid #d7dee8;
  border-radius: 6px;
  background: #ffffff;
}

.placeholder-panel h3 {
  font-size: 14px;
  margin-bottom: 16px;
}

.placeholder-line {
  height: 10px;
  border-radius: 999px;
  background: #d8e0ea;
  margin-bottom: 10px;
}

.placeholder-line--short {
  width: 62%;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid #cfd8e5;
  font-size: 12px;
  font-weight: 700;
}

.status-badge--neutral {
  color: #334155;
  background: #f8fafc;
}

.status-badge--ready {
  color: #11623f;
  background: #e7f7ef;
  border-color: #b9e4ce;
}

.status-badge--warning {
  color: #76510d;
  background: #fff6d8;
  border-color: #edd58a;
}

@media (max-width: 760px) {
  .topbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .workspace {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: 0;
    border-bottom: 1px solid #d7dee8;
  }

  .section-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .content-panel {
    padding: 16px;
  }

  .content-panel__heading,
  .placeholder-grid {
    grid-template-columns: 1fr;
  }

  .placeholder-grid {
    display: grid;
  }
}
```

- [ ] **Step 6: Run UI tests**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web exec vitest run src/App.test.tsx
```

Expected: PASS.

## Task 6: Verification, Docs Link, And Commit

**Files:**

- Modify: `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`

- [ ] **Step 1: Link this execution plan from the master plan**

In `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`, under `## Slice: RPA Workspace Package Skeleton`, add:

```markdown
**Execution plan:** `docs/superpowers/plans/2026-06-05-rpa-local-web-skeleton.md`
```

- [ ] **Step 2: Run package verification**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm --filter @lance-agent-runner/rpa-local-web typecheck
pnpm --filter @lance-agent-runner/rpa-local-web build
```

Expected: all PASS. If server route tests fail with `listen EPERM` inside the sandbox, rerun the exact test command with escalated permission for local listen.

- [ ] **Step 3: Run root verification**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: all PASS and root aggregation includes `typecheck:rpa-local-web` and `build:rpa-local-web`.

- [ ] **Step 4: Review diff for boundary violations**

Run:

```bash
git diff --stat
rg -n "rpa|RPA|Playwright|flow\\.dsl|flow\\.hardened" apps/daemon/src
```

Expected:

- Diff contains `apps/rpa-local-web`, root package scripts, and plan/doc changes only.
- `apps/daemon/src` search should not show new RPA or Playwright product logic from this slice.

- [ ] **Step 5: Commit**

Run:

```bash
git add package.json pnpm-lock.yaml apps/rpa-local-web docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md
git commit -m "Add RPA local web workspace skeleton"
```

Expected: commit succeeds with no co-author trailer.

## Acceptance Checklist

- [x] New package `@lance-agent-runner/rpa-local-web` exists under `apps/rpa-local-web`.
- [x] Root scripts include `dev:rpa-local-web`, `build:rpa-local-web`, `test:rpa-local-web`, `typecheck:rpa-local-web`.
- [x] Root `pnpm typecheck` includes the RPA package.
- [x] Root `pnpm build` includes the RPA package.
- [x] Backend exposes `/api/rpa/health`, `/api/rpa/config`, and `/api/rpa/daemon/health`.
- [x] Backend does not expose daemon API key to the browser.
- [x] Server-side daemon client supports workspace creation, file upload, run creation, run cancel, run artifact list, artifact download, and SSE subscription.
- [x] UI shell has sections for codegen hardening, natural-language generation, flows, executions, and settings.
- [x] No RPA product logic is added to `apps/daemon/src`.

Completion evidence:

- Commit: `e75a5ef Add RPA local web workspace skeleton`.
- Verification before commit: `pnpm typecheck`, `pnpm build`, and `pnpm test`.
- CC review result: no P0/P1 after the `getDaemonHealth` diagnostic response fix.

## CC Review Prompt After Implementation

Use this prompt after the slice is implemented and committed:

```text
Review only. Do not edit files.

Repo: /home/orangels/ls_dev/lance-agent-runner-daemon
Base SHA: <base-sha-before-skeleton>
Head SHA: <head-sha-after-skeleton>

Task background:
This repo is a standalone Claude Code runner daemon plus local apps. We are adding apps/rpa-local-web as the product-layer local B/S RPA MVP app. The daemon must remain generic and must not import or understand RPA product logic.

Implemented in this slice:
- New @lance-agent-runner/rpa-local-web package.
- Root dev/build/test/typecheck scripts for the package.
- Local Express BFF with /api/rpa/* namespace and Vite/production serving.
- Server-side typed daemon client for workspace, upload, createRun, cancelRun, SSE, artifacts, and downloads.
- Browser-side local RPA API client.
- Dense operational React UI shell with codegen, natural-language, flows, executions, and settings sections.
- Smoke tests and root verification.

Please review:
1. Any P0/P1 package, build, test, or runtime issues.
2. Whether apps/daemon remains generic and unmodified by RPA product logic.
3. Whether the local BFF leaks daemon API keys, absolute sandbox paths, or daemon internals to the browser.
4. Whether the daemon client API surface is sufficient for later codegen/natural-language workflow slices.
5. Whether the server structure can later host executor routes without becoming a separate service.
6. Whether the UI shell violates existing frontend guidance or product-scope constraints.

Expected output:
- Overall verdict.
- P0/P1 findings first with file/line references.
- Required fixes before proceeding.
- P2 suggestions that can wait.
- Final recommendation on whether to proceed to the RPA DSL/artifact contract slice.
```

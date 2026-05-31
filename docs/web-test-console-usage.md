# Web Test Console Usage

`apps/web` is a local browser demo for business-side integration testing. It is not a production portal and does not provide production auth, multi-user permission, or business persistence.

## Start

Install dependencies once:

```bash
pnpm install
```

Start the daemon with a local config:

```bash
CLAUDE_RUNNER_LQBOT_API_KEY=local-test pnpm dev:daemon
```

Start the web console:

```bash
pnpm dev:web
```

Open the Vite URL shown in the terminal. By default, leave `Daemon URL` blank. Blank means the web app calls same-origin `/api/*`, and the Vite dev server proxies those requests to:

```text
http://127.0.0.1:17890
```

This avoids browser CORS preflight issues while keeping API keys in the `Authorization` header. Paste the API key used by the daemon client config, then click `Load profiles`.

If your daemon listens somewhere else, either edit `apps/web/vite.config.ts` or enter a fully qualified daemon URL and ensure that deployment path provides CORS or a reverse proxy.

## What The Console Demonstrates

The console shows three business adapter flows:

1. `Generate + SSE`
   - Creates or reuses a workspace.
   - Uploads selected files one at a time through `POST /api/workspaces/:workspaceId/files`.
   - Creates `POST /api/runs` with `kind: "generate"` and `skillId`.
   - Opens `/api/runs/:runId/events` with authenticated `fetch`.
   - Reconciles final durable detail and artifact list after terminal `data.type === "end"`.

2. `Generate + Poll`
   - Creates the same kind of `generate` run.
   - Does not call `/events`.
   - Polls `GET /api/runs/:runId`.
   - Updates the same local assistant bubble from durable `run_messages`.

3. `Revise`
   - Requires an existing workspace from an earlier run.
   - Creates `POST /api/runs` with `kind: "revise"`.
   - Omits `skillId`.
   - Uses SSE by default and refreshes artifacts after terminal.

## Mapping To Business Systems

The demo keeps chat state in browser memory. A business system should persist its own project/thread/message rows and store daemon IDs alongside them:

```text
business project/thread
  -> daemon workspaceId
  -> daemon runId
  -> daemon artifactId
```

Use this console as a reference for request shape, streaming, durable detail reconciliation, and artifact download. Do not treat browser state as the business database.

## SSE Auth

The console intentionally uses browser `fetch` plus `ReadableStream` for SSE. It does not use native `EventSource`, because API keys must not be placed in query strings. Every protected daemon request sends:

```text
Authorization: Bearer <api-key>
```

## File Upload Notes

The daemon upload endpoint accepts exactly one `file` field per request plus one `targetPath` field. For multiple selected files, the console loops and sends one multipart request per file.

Do not manually set `Content-Type` for multipart upload requests. The browser must add the `multipart/form-data` boundary.

## Limitations

- No production auth UI.
- No persisted demo state.
- No business DB integration.
- No multi-skill API change.
- No daemon API contract change.
- No preview iframe or lanceDesign product-specific UI.

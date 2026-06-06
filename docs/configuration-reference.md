# Configuration Reference

This daemon reads a single JSON config file. Use `config.example.json` as the copyable template.

Start with an explicit config path:

```bash
pnpm dev:daemon
```

or:

```bash
pnpm start:daemon:local
```

Relative filesystem paths inside the config file are resolved from the directory that contains the loaded config file. This keeps both repository-root examples and `.claude-runner/config.local.json` portable when the daemon is started through a workspace package script. The config file path itself should be passed as an absolute path, or via the provided local scripts. `claudeConfigDir` is also resolved to an absolute path before being passed to the Claude Code child process as `CLAUDE_CONFIG_DIR`.

## Example Setup

```bash
cp config.example.json .claude-runner/config.local.json
export CLAUDE_RUNNER_LQBOT_API_KEY="replace-with-a-secret"
pnpm dev:daemon
```

The repository tracks `.claude-runner/config.local.json` and empty directory placeholders so a fresh checkout has the expected local runtime layout. Runtime contents under `.claude-runner/data`, `.claude-runner/uploads`, `.claude-runner/workspaces`, and Claude login/config files under `.claude-runner/profiles/*/claude` remain ignored except for `.gitkeep` placeholders.

## Top-Level Keys

### `server`

Runtime settings for the daemon process.

### `clients`

Trusted business callers. Each client has one API key and a list of profiles it may use.

### `profiles`

Claude Code execution profiles. A profile controls workspace roots, Claude Code config, allowed daemon skills, artifact rules, models, visibility, concurrency, timeouts, and allowed environment variables.

## `server` Keys

### `server.host`

HTTP listen host.

Use `127.0.0.1` when another service on the same machine proxies calls to the daemon. Use `0.0.0.0` only when the deployment network boundary is controlled.

### `server.port`

HTTP listen port.

Example:

```json
"port": 17890
```

### `server.dataDir`

Daemon runtime data directory. The daemon stores SQLite, service logs, run logs, and upload temp files under this directory.

With the example value:

```json
"dataDir": "data"
```

the SQLite file is:

```text
.claude-runner/data/runner.sqlite
```

Service-level logs are written as JSON lines:

```text
.claude-runner/data/logs/daemon.log
.claude-runner/data/logs/daemon-error.log
```

`daemon.log` records daemon startup/shutdown, HTTP request summaries, and service events. `daemon-error.log` receives `warn` and `error` events, including local stack traces for unexpected daemon errors. These service logs are local files only; they are not exposed through the run logs API.

### `server.globalConcurrency`

Maximum number of Claude Code child processes that may run across all profiles.

Queued runs wait until capacity is available.

### `server.maxQueueSize`

Maximum number of queued runs. If the queue is full, `POST /api/runs` returns `429 RUN_QUEUE_FULL` before inserting a run row.

### `server.logRetentionMs`

How long finished run log indexes are retained, in milliseconds.

Example:

```text
604800000 = 7 days
```

### `server.maxLogBytesPerRun`

Maximum bytes written to each per-run log file. The daemon writes bounded stdout, stderr, and debug event logs.

Per-run logs are separate from service logs and live under:

```text
.claude-runner/data/logs/runs/<runId>/
```

### `server.maxReviewBundleBytes`

Maximum total byte count for the generic run review bundle before ZIP creation.

Default:

```text
16777216 = 16 MiB
```

If an on-demand review bundle would exceed this limit, the daemon returns
`413 REVIEW_BUNDLE_TOO_LARGE`.

### `server.maxUploadBytesPerFile`

Maximum size for `POST /api/workspaces/:workspaceId/files`.

Example:

```text
52428800 = 50 MiB
```

### `server.uploadTempRetentionMs`

How long stale upload temp directories may remain before startup pruning removes them.

## `clients[]` Keys

### `clients[].id`

Stable business caller id.

This value is stored on workspaces and runs for client isolation.

### `clients[].apiKey`

API key used by the client.

Use `env:VARIABLE_NAME` to resolve the secret from the daemon process environment:

```json
"apiKey": "env:CLAUDE_RUNNER_LQBOT_API_KEY"
```

The client sends it as:

```text
Authorization: Bearer <api-key>
```

or:

```text
X-API-Key: <api-key>
```

### `clients[].allowedProfileIds`

Profiles this client may use.

Non-admin clients can only list, create workspaces for, and create runs for these profiles.

### `clients[].canReadDebugEvents`

Allows this client to receive `debug` event visibility when the profile and run request also allow it.

If false, requested `debug` visibility is capped to `normal`.

It is required for:

```text
GET /api/runs/:runId/logs/debug-events/download
```

It is also required for debug-only files inside review bundles, such as
`logs/debug-events.ndjson` and `messages.debug.json`.

It is also required, together with `canReadLogs`, when a run requests
`collectionMode: "review"`.

### `clients[].canReadLogs`

Allows this client to call:

```text
GET /api/runs/:runId/logs
GET /api/runs/:runId/logs/stdout/download
GET /api/runs/:runId/logs/stderr/download
GET /api/runs/:runId/review-bundle/download
```

It is also required when a run requests `collectionMode: "diagnostic"` or
`collectionMode: "review"`.

### `clients[].isAdmin`

Allows cross-client workspace/run reads in repository lookups.

Keep this false for normal business callers.

## `profiles[]` Keys

### `profiles[].id`

Profile id used by:

```text
POST /api/workspaces
POST /api/runs
```

Example:

```json
"id": "report-docx"
```

### `profiles[].sandboxRoot`

Root directory for workspaces created under this profile.

With:

```json
"sandboxRoot": "workspaces/report-docx"
```

a workspace may be created as:

```text
.claude-runner/workspaces/report-docx/<originId>/<userId>/<projectId>/
  input/
  output/
  work/
  .claude-runner-skills/
```

The Claude Code child process runs with this workspace as its `cwd`.

### `profiles[].claudeConfigDir`

Directory injected into Claude Code as:

```text
CLAUDE_CONFIG_DIR=<profiles[].claudeConfigDir>
```

Use a relative project-local directory for portable deployments:

```json
"claudeConfigDir": "profiles/report-docx/claude"
```

The daemon resolves this to an absolute path before spawning Claude Code, so the child process does not interpret it relative to the workspace `cwd`.

If you want to reuse a machine user's default Claude Code config, either set this field in that machine's local config to an absolute path such as `/home/orangels/.claude`, or make the project-local directory a symlink to the user's Claude config directory.

Do not use `~/.claude`; the daemon does not expand `~`.

### `profiles[].claudeBin`

Claude Code CLI binary.

Use:

```json
"claudeBin": "claude"
```

to resolve from `PATH`, or use an absolute path to pin a binary.

### `profiles[].skillRoots`

Directories containing daemon-managed business skills.

The daemon scans one directory level below each root:

```text
apps/daemon/skills/
  report-gen/
    SKILL.md
    guides/
```

Skill id resolution is:

```text
frontmatter.id -> frontmatter.name -> folder name
```

### `profiles[].allowedInputRoots`

Source-file whitelist for:

```text
POST /api/workspaces/:workspaceId/prepare
```

`prepare` copies from `sourcePath` under one of these roots into the workspace.

This does not affect the upload API. `POST /api/workspaces/:workspaceId/files` writes to daemon temp storage first, then copies into the workspace.

### `profiles[].allowedSkillIds`

Business skill ids allowed for `kind=generate`.

Example:

```json
"allowedSkillIds": ["report-gen"]
```

`legacy + generate` and MVP `business-context` requests must use one of these ids:

```json
{
  "kind": "generate",
  "skillId": "report-gen"
}
```

`legacy + revise` forbids `skillId`. `business-context + revise` uses `skillId`
when continuing a skill-driven workflow.

### `profiles[].artifactRules`

Rules used to discover artifacts after a run finishes.

Each rule has:

- `id`: artifact rule id used by `artifactRuleIds`.
- `pattern`: glob pattern relative to workspace root.
- `role`: artifact role. Allowed values are `primary`, `supporting`, or `debug`.
  When multiple rules match the same workspace-relative file, the daemon keeps
  only the highest-priority role for that file: `primary` > `supporting` > `debug`.
- `required`: if true, a successful Claude exit is rewritten to failed when no artifact matches this rule.

### `profiles[].defaultArtifactRuleIds`

Artifact rules used when `POST /api/runs` does not provide `artifactRuleIds`.

### `profiles[].permissionMode`

Claude Code permission mode passed as:

```text
--permission-mode <value>
```

Allowed values:

```text
default
acceptEdits
bypassPermissions
```

This daemon is directory-isolation only. If you use `bypassPermissions`, the Claude Code child process has the daemon process user's file and network permissions.

### `profiles[].defaultModel`

Model used when `POST /api/runs` does not provide `model`.

The default model must also be included in `allowedModels`.

### `profiles[].allowedModels`

Models accepted from `POST /api/runs.model`.

If a request provides a model outside this list, the daemon returns `400 MODEL_NOT_ALLOWED`.

### `profiles[].eventVisibility`

Default and maximum event visibility for this profile.

Allowed values:

```text
quiet
normal
debug
```

Run requests may lower visibility, but cannot raise it above the profile/client ceiling.

`eventVisibility` only controls SSE/API event detail. It does not decide whether
prompt, skill, business context, logs, or review materials are persisted.

### `profiles[].maxCollectionMode`

Maximum collection mode this profile allows for run-level prompt/context
snapshots.

Allowed values:

```text
lite
diagnostic
review
```

Default: `lite`.

Run requests may set `collectionMode`; the daemon rejects requests above this
profile cap before inserting a run row. Client permissions are also checked:

- `lite`: no extra log/debug permission required.
- `diagnostic`: requires `clients[].canReadLogs = true`.
- `review`: requires both `clients[].canReadLogs = true` and
  `clients[].canReadDebugEvents = true`.

`collectionMode` is independent from `eventVisibility`.

### `profiles[].profileConcurrency`

Maximum number of running Claude Code child processes for this profile.

### `profiles[].runTimeoutMs`

Total running timeout in milliseconds.

This starts when the run transitions to `running`, not while it waits in `queued`.

### `profiles[].inactivityTimeoutMs`

Timeout in milliseconds when Claude Code produces no stdout, stderr, or parsed stream events.

### `profiles[].cancelGraceMs`

Milliseconds to wait after cancel/SIGTERM before SIGKILL fallback.

### `profiles[].env`

Allowlisted environment variables overlaid onto the Claude Code child process environment.

Allowed keys:

```text
ANTHROPIC_BASE_URL
ANTHROPIC_API_KEY
DISABLE_TELEMETRY
DO_NOT_TRACK
DISABLE_AUTOUPDATER
DISABLE_ERROR_REPORTING
DISABLE_BUG_COMMAND
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
```

Unlike `clients[].apiKey`, `profiles[].env` values are literal strings in the current implementation. `env:VARIABLE_NAME` expansion is not supported for profile env values yet.

For portable deployments, prefer putting non-secret behavior flags here and manage Claude credentials through `claudeConfigDir` or the daemon process environment.

## Relative Path Guidance

The example config uses relative paths for project-owned directories:

```json
"dataDir": "data",
"sandboxRoot": "workspaces/report-docx",
"claudeConfigDir": "profiles/report-docx/claude",
"skillRoots": ["../apps/daemon/skills"],
"allowedInputRoots": ["uploads"]
```

In `.claude-runner/config.local.json`, these paths are relative to `.claude-runner/`. If you load `config.example.json` directly from the repository root, use repository-root-relative values such as `.claude-runner/data`, `apps/daemon/skills`, and `.claude-runner/uploads`.

For systemd:

```ini
WorkingDirectory=/path/to/lance-agent-runner-daemon
Environment=CLAUDE_RUNNER_CONFIG=/path/to/lance-agent-runner-daemon/.claude-runner/config.local.json
```

For Docker or process managers, prefer setting `CLAUDE_RUNNER_CONFIG` to an absolute config file path; path fields inside that file stay relative to the file itself.

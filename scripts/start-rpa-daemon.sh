#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export DISPLAY="${DISPLAY:-:2}"
export RPA_DAEMON_API_KEY="${RPA_DAEMON_API_KEY:-rpa-local-dev-key}"
export CLAUDE_RUNNER_LQBOT_API_KEY="${CLAUDE_RUNNER_LQBOT_API_KEY:-lqbot-dev-key}"

exec pnpm dev:daemon

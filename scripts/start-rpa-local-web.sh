#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export PATH="/home/orangels/miniforge3/bin:$PATH"
export DISPLAY="${DISPLAY:-:2}"
export RPA_LOCAL_HOST="${RPA_LOCAL_HOST:-0.0.0.0}"
export RPA_LOCAL_PORT="${RPA_LOCAL_PORT:-5174}"
export RPA_LOCAL_STORAGE_ROOT="${RPA_LOCAL_STORAGE_ROOT:-/mnt/8t/ls_data/rpa-local-data}"
export RPA_DAEMON_BASE_URL="${RPA_DAEMON_BASE_URL:-http://127.0.0.1:17890}"
export RPA_DAEMON_API_KEY="${RPA_DAEMON_API_KEY:-rpa-local-dev-key}"
export RPA_DAEMON_PROFILE_ID="${RPA_DAEMON_PROFILE_ID:-rpa-local}"
export RPA_CODEGEN_COMMAND="${RPA_CODEGEN_COMMAND:-/home/orangels/miniforge3/bin/python}"
export RPA_CODEGEN_ARGS_JSON="${RPA_CODEGEN_ARGS_JSON:-[\"-m\",\"playwright\",\"codegen\"]}"

exec pnpm dev:rpa-local-web

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

pid_file="${DAEMON_PID_FILE:-.claude-runner/data/daemon-local.pid}"
wrapper_log="${DAEMON_WRAPPER_LOG:-.claude-runner/data/logs/daemon-local.out.log}"
env_file="${DAEMON_ENV_FILE:-.env}"
config_file="${DAEMON_CONFIG_FILE:-.claude-runner/config.local.json}"
stop_timeout_seconds="${DAEMON_STOP_TIMEOUT_SECONDS:-30}"
build_before_start=1

usage() {
  cat <<'USAGE'
Usage:
  scripts/daemon-local.sh start [--skip-build]
  scripts/daemon-local.sh stop
  scripts/daemon-local.sh restart [--skip-build]
  scripts/daemon-local.sh status
  scripts/daemon-local.sh logs

Local daemon process manager for business integration testing.

Defaults:
  config: .claude-runner/config.local.json
  env:    .env
  pid:    .claude-runner/data/daemon-local.pid
  log:    .claude-runner/data/logs/daemon-local.out.log

Environment overrides:
  DAEMON_CONFIG_FILE
  DAEMON_ENV_FILE
  DAEMON_PID_FILE
  DAEMON_WRAPPER_LOG
  DAEMON_STOP_TIMEOUT_SECONDS
  CLAUDE_RUNNER_LQBOT_API_KEY   default: lancelocal-report
  RPA_DAEMON_API_KEY            default: local-rpa-test-key
USAGE
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

resolve_path() {
  local value="$1"
  case "$value" in
    /*) printf '%s\n' "$value" ;;
    *) printf '%s\n' "$repo_root/$value" ;;
  esac
}

read_pid() {
  if [[ -f "$pid_file" ]]; then
    tr -d '[:space:]' < "$pid_file"
  fi
}

is_running() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

clear_stale_pid() {
  local pid
  pid="$(read_pid || true)"
  if [[ -n "$pid" && ! "$pid" =~ ^[0-9]+$ ]]; then
    rm -f "$pid_file"
    return
  fi
  if [[ -n "$pid" ]] && ! is_running "$pid"; then
    rm -f "$pid_file"
  fi
}

start_daemon() {
  clear_stale_pid
  local existing_pid
  existing_pid="$(read_pid || true)"
  if is_running "$existing_pid"; then
    echo "Daemon already running with PID $existing_pid"
    return 0
  fi

  [[ -f "$config_file" ]] || die "config file not found: $config_file"
  [[ -f "$env_file" ]] || die "env file not found: $env_file"

  mkdir -p "$(dirname "$pid_file")" "$(dirname "$wrapper_log")"

  if [[ "$build_before_start" -eq 1 ]]; then
    echo "Building daemon..."
    pnpm build:daemon
  fi

  local absolute_config absolute_env entry
  absolute_config="$(resolve_path "$config_file")"
  absolute_env="$(resolve_path "$env_file")"
  entry="$repo_root/apps/daemon/dist/index.js"
  [[ -f "$entry" ]] || die "daemon entry not found: $entry"

  echo "Starting daemon..."
  echo "Config: $absolute_config"
  echo "Log:    $(resolve_path "$wrapper_log")"

  (
    cd "$repo_root"
    export CLAUDE_RUNNER_LQBOT_API_KEY="${CLAUDE_RUNNER_LQBOT_API_KEY:-lancelocal-report}"
    export RPA_DAEMON_API_KEY="${RPA_DAEMON_API_KEY:-local-rpa-test-key}"
    exec node --env-file="$absolute_env" "$entry" --config "$absolute_config"
  ) >> "$wrapper_log" 2>&1 &

  local pid=$!
  printf '%s\n' "$pid" > "$pid_file"
  sleep 1

  if ! is_running "$pid"; then
    rm -f "$pid_file"
    echo "Daemon failed to stay running. Last log lines:" >&2
    tail -n 80 "$wrapper_log" >&2 || true
    exit 1
  fi

  echo "Daemon started with PID $pid"
}

stop_daemon() {
  clear_stale_pid
  local pid
  pid="$(read_pid || true)"
  if [[ -z "$pid" ]]; then
    echo "Daemon is not running."
    return 0
  fi
  [[ "$pid" =~ ^[0-9]+$ ]] || die "invalid PID file: $pid_file"

  echo "Stopping daemon PID $pid..."
  kill -TERM "$pid" >/dev/null 2>&1 || true

  local elapsed=0
  while is_running "$pid"; do
    if (( elapsed >= stop_timeout_seconds )); then
      echo "Daemon did not stop within ${stop_timeout_seconds}s; sending SIGKILL."
      kill -KILL "$pid" >/dev/null 2>&1 || true
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  rm -f "$pid_file"
  echo "Daemon stopped."
}

status_daemon() {
  clear_stale_pid
  local pid
  pid="$(read_pid || true)"
  if is_running "$pid"; then
    echo "Daemon running with PID $pid"
    return 0
  fi
  echo "Daemon is not running."
  return 0
}

show_logs() {
  if [[ ! -f "$wrapper_log" ]]; then
    echo "Log file does not exist yet: $wrapper_log"
    return 0
  fi
  tail -n 120 -f "$wrapper_log"
}

command="${1:-}"
if [[ -z "$command" ]]; then
  usage
  exit 2
fi
shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      build_before_start=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$command" in
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    stop_daemon
    start_daemon
    ;;
  status)
    status_daemon
    ;;
  logs)
    show_logs
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

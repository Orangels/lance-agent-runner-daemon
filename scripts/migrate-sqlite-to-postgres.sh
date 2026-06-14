#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

sqlite_path="${SQLITE_PATH:-.claude-runner/data/runner.sqlite}"
backup_dir="${BACKUP_DIR:-.claude-runner/data/backups}"
env_file=".env"
load_env=1
skip_backup=0
dry_run_only=0
assume_yes=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/migrate-sqlite-to-postgres.sh [options]

Migrates the local SQLite daemon database into the PostgreSQL database pointed to
by CLAUDE_RUNNER_DATABASE_URL.

Options:
  --sqlite <path>       SQLite source path. Defaults to SQLITE_PATH or .claude-runner/data/runner.sqlite.
  --backup-dir <path>   Backup directory. Defaults to BACKUP_DIR or .claude-runner/data/backups.
  --env-file <path>     Env file to load. Defaults to .env.
  --skip-env            Do not load an env file.
  --skip-backup         Do not create a SQLite backup before migration.
  --dry-run-only        Apply PG schema and run the dry-run copy, then stop.
  -y, --yes             Skip the interactive confirmation prompt.
  -h, --help            Show this help.

Notes:
  - Stop the daemon before running this script.
  - This script never drops or resets PostgreSQL data.
  - The PostgreSQL URL is required but is not printed by this script.
USAGE
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "ERROR: $option requires a value." >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sqlite)
      require_value "$1" "${2:-}"
      sqlite_path="$2"
      shift 2
      ;;
    --backup-dir)
      require_value "$1" "${2:-}"
      backup_dir="$2"
      shift 2
      ;;
    --env-file)
      require_value "$1" "${2:-}"
      env_file="$2"
      shift 2
      ;;
    --skip-env)
      load_env=0
      shift
      ;;
    --skip-backup)
      skip_backup=1
      shift
      ;;
    --dry-run-only)
      dry_run_only=1
      shift
      ;;
    -y|--yes)
      assume_yes=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$repo_root"

case "$sqlite_path" in
  /*)
    ;;
  *)
    sqlite_path="$repo_root/$sqlite_path"
    ;;
esac

case "$backup_dir" in
  /*)
    ;;
  *)
    backup_dir="$repo_root/$backup_dir"
    ;;
esac

if [[ "$load_env" -eq 1 ]]; then
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  elif [[ "$env_file" != ".env" ]]; then
    echo "ERROR: env file not found: $env_file" >&2
    exit 1
  fi
fi

if [[ -z "${CLAUDE_RUNNER_DATABASE_URL:-}" ]]; then
  echo "ERROR: CLAUDE_RUNNER_DATABASE_URL is required." >&2
  echo "Set it in .env or export it before running this script." >&2
  exit 1
fi

if [[ ! -f "$sqlite_path" ]]; then
  echo "ERROR: SQLite source not found: $sqlite_path" >&2
  exit 1
fi

for suffix in -journal -wal -shm; do
  if [[ -e "${sqlite_path}${suffix}" ]]; then
    echo "ERROR: SQLite sidecar exists: ${sqlite_path}${suffix}" >&2
    echo "Stop the daemon and checkpoint/close SQLite before migrating." >&2
    exit 1
  fi
done

if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm is required but was not found in PATH." >&2
  exit 1
fi

if [[ "$assume_yes" -eq 0 ]]; then
  if [[ ! -t 0 ]]; then
    echo "ERROR: non-interactive migration requires --yes." >&2
    exit 1
  fi

  echo "This will migrate SQLite data into the configured PostgreSQL database."
  echo "SQLite source: $sqlite_path"
  echo "Stop the daemon before continuing. PostgreSQL data will not be dropped or reset."
  read -r -p "Continue? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES)
      ;;
    *)
      echo "Aborted."
      exit 0
      ;;
  esac
fi

if [[ "$skip_backup" -eq 0 ]]; then
  mkdir -p "$backup_dir"
  timestamp="$(date +%Y%m%d-%H%M%S)"
  backup_path="${backup_dir%/}/$(basename "$sqlite_path").${timestamp}.bak"
  echo "Creating SQLite backup: $backup_path"
  cp -p "$sqlite_path" "$backup_path"
else
  echo "Skipping SQLite backup."
fi

echo "Applying PostgreSQL schema migrations..."
pnpm --filter @lance-agent-runner/daemon db:migrate:pg

echo "Running SQLite-to-PostgreSQL dry-run..."
pnpm --filter @lance-agent-runner/daemon db:migrate:sqlite-to-pg --sqlite "$sqlite_path" --dry-run

if [[ "$dry_run_only" -eq 1 ]]; then
  echo "Dry-run completed. Actual data copy was skipped."
  exit 0
fi

echo "Copying SQLite data into PostgreSQL..."
pnpm --filter @lance-agent-runner/daemon db:migrate:sqlite-to-pg --sqlite "$sqlite_path"

echo "Verifying copied data..."
pnpm --filter @lance-agent-runner/daemon db:verify:sqlite-to-pg --sqlite "$sqlite_path"

echo "Migration complete."

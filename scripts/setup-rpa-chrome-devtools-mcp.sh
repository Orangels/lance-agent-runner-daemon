#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  setup-rpa-chrome-devtools-mcp.sh [options]

Options:
  --mode online|offline       online uses npx; offline uses a local JS entrypoint.
                              Defaults to RPA_CHROME_DEVTOOLS_MCP_MODE or online.
  --bin <path>                Required in offline mode. Path to chrome-devtools-mcp JS entrypoint.
                              Defaults to RPA_CHROME_DEVTOOLS_MCP_BIN.
  --package <pkg>             Online package spec. Defaults to
                              RPA_CHROME_DEVTOOLS_MCP_PACKAGE or chrome-devtools-mcp@latest.
  --server-name <name>        MCP server name. Defaults to RPA_CHROME_DEVTOOLS_MCP_NAME or chrome-dev-mcp.
  --claude-config-dir <path>  Claude config dir used by daemon. Defaults to CLAUDE_CONFIG_DIR or /home/orangels/.claude.
  -h, --help                  Show this help.

Examples:
  pnpm setup:rpa-chrome-devtools-mcp -- --mode online
  pnpm setup:rpa-chrome-devtools-mcp -- --mode offline --bin /opt/rpa-mcp/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js
USAGE
}

claude_config_dir="${CLAUDE_CONFIG_DIR:-/home/orangels/.claude}"
server_name="${RPA_CHROME_DEVTOOLS_MCP_NAME:-chrome-dev-mcp}"
mode="${RPA_CHROME_DEVTOOLS_MCP_MODE:-online}"
offline_bin="${RPA_CHROME_DEVTOOLS_MCP_BIN:-}"
online_package="${RPA_CHROME_DEVTOOLS_MCP_PACKAGE:-chrome-devtools-mcp@latest}"

read_option_value() {
  local option="$1"
  local value="${2-}"
  if [[ -z "${value}" || "${value}" == --* ]]; then
    echo "ERROR: ${option} requires a value." >&2
    usage >&2
    exit 1
  fi
  printf '%s' "${value}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --mode)
      mode="$(read_option_value "$1" "${2-}")"
      shift 2
      ;;
    --bin)
      offline_bin="$(read_option_value "$1" "${2-}")"
      shift 2
      ;;
    --package)
      online_package="$(read_option_value "$1" "${2-}")"
      shift 2
      ;;
    --server-name)
      server_name="$(read_option_value "$1" "${2-}")"
      shift 2
      ;;
    --claude-config-dir)
      claude_config_dir="$(read_option_value "$1" "${2-}")"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude command is not available on PATH." >&2
  exit 1
fi

if ! command -v google-chrome >/dev/null 2>&1; then
  echo "ERROR: google-chrome is not available on PATH." >&2
  echo "Install Google Chrome before setting up chrome-devtools-mcp." >&2
  exit 1
fi

case "${mode}" in
  online)
    if ! command -v npx >/dev/null 2>&1; then
      echo "ERROR: npx command is not available on PATH." >&2
      exit 1
    fi
    mcp_command="npx"
    mcp_args=("${online_package}" "--headless=true" "--isolated=true")
    ;;
  offline)
    if [[ -z "${offline_bin}" ]]; then
      echo "ERROR: --bin is required in offline mode." >&2
      usage >&2
      exit 1
    fi
    if [[ ! -f "${offline_bin}" ]]; then
      echo "ERROR: offline chrome-devtools-mcp entrypoint not found: ${offline_bin}" >&2
      exit 1
    fi
    if ! command -v node >/dev/null 2>&1; then
      echo "ERROR: node command is not available on PATH." >&2
      exit 1
    fi
    mcp_command="node"
    mcp_args=("${offline_bin}" "--headless=true" "--isolated=true")
    ;;
  *)
    echo "ERROR: Unsupported mode: ${mode}. Expected online or offline." >&2
    usage >&2
    exit 1
    ;;
esac

join_command() {
  local command="$1"
  shift
  local joined="${command}"
  for arg in "$@"; do
    joined+=" ${arg}"
  done
  printf '%s' "${joined}"
}

echo "Using CLAUDE_CONFIG_DIR=${claude_config_dir}"
echo "Using mode=${mode}"
echo "Using MCP command: $(join_command "${mcp_command}" "${mcp_args[@]}")"

current_line="$(
  CLAUDE_CONFIG_DIR="${claude_config_dir}" claude mcp list 2>/tmp/rpa-chrome-devtools-mcp-list.log \
    | grep "^${server_name}:" || true
)"
desired_command="$(join_command "${mcp_command}" "${mcp_args[@]}")"

if [[ -n "${current_line}" && "${current_line}" == *": ${desired_command} - "* ]]; then
  echo "MCP server '${server_name}' is already configured for ${mode} mode."
else
  if [[ -n "${current_line}" ]]; then
    echo "MCP server '${server_name}' exists with a different command; replacing it."
    CLAUDE_CONFIG_DIR="${claude_config_dir}" claude mcp remove "${server_name}" >/dev/null
  fi
  echo "Adding MCP server '${server_name}'..."
  CLAUDE_CONFIG_DIR="${claude_config_dir}" claude mcp add -s user "${server_name}" -- \
    "${mcp_command}" "${mcp_args[@]}"
fi

echo "Verifying MCP server health..."
CLAUDE_CONFIG_DIR="${claude_config_dir}" claude mcp list

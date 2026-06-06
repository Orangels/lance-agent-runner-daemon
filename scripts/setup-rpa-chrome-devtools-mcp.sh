#!/usr/bin/env bash
set -euo pipefail

claude_config_dir="${CLAUDE_CONFIG_DIR:-/home/orangels/.claude}"
server_name="${RPA_CHROME_DEVTOOLS_MCP_NAME:-chrome-dev-mcp}"

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude command is not available on PATH." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx command is not available on PATH." >&2
  exit 1
fi

if ! command -v google-chrome >/dev/null 2>&1; then
  echo "ERROR: google-chrome is not available on PATH." >&2
  echo "Install Google Chrome before setting up chrome-devtools-mcp." >&2
  exit 1
fi

echo "Using CLAUDE_CONFIG_DIR=${claude_config_dir}"

if CLAUDE_CONFIG_DIR="${claude_config_dir}" claude mcp list 2>/tmp/rpa-chrome-devtools-mcp-list.log \
  | grep -q "^${server_name}:"; then
  echo "MCP server '${server_name}' is already configured."
else
  echo "Adding MCP server '${server_name}'..."
  CLAUDE_CONFIG_DIR="${claude_config_dir}" claude mcp add -s user "${server_name}" -- \
    npx chrome-devtools-mcp@latest --headless=true --isolated=true
fi

echo "Verifying MCP server health..."
CLAUDE_CONFIG_DIR="${claude_config_dir}" claude mcp list


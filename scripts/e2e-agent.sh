#!/bin/sh
# End-to-end: give a real agent (Claude Code, headless) ONLY the PhoneDock MCP tools and a task.
# Usage: scripts/e2e-agent.sh "<task>" [extra claude args…]
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TASK="$1"; shift || true
CFG="$(mktemp -t phonedock-mcp).json"
cat > "$CFG" <<JSON
{ "mcpServers": { "phonedock": { "command": "$REPO/bin/phonedock", "args": ["mcp"] } } }
JSON
exec claude -p "$TASK" \
  --mcp-config "$CFG" --strict-mcp-config \
  --allowedTools "mcp__phonedock__*" \
  --output-format text "$@"

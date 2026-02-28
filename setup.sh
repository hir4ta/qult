#!/bin/sh
# claude-buddy initial setup
# Usage: curl -fsSL https://raw.githubusercontent.com/hir4ta/claude-buddy/main/setup.sh | sh
#
# What this does:
#   1. Finds the plugin in ~/.claude/plugins/cache/
#   2. Downloads the claude-buddy binary
#   3. Syncs past sessions and generates embeddings
#
# To enable semantic search, set VOYAGE_API_KEY before running:
#   export VOYAGE_API_KEY=pa-xxx
#   curl -fsSL https://raw.githubusercontent.com/hir4ta/claude-buddy/main/setup.sh | sh

set -e

echo "claude-buddy setup"
echo "==================="
echo ""

# Find the latest plugin installation.
RUN_SH=$(find ~/.claude/plugins/cache -name "run.sh" -path "*/claude-buddy/*/bin/*" -type f 2>/dev/null | sort -V | tail -1)

if [ -z "$RUN_SH" ]; then
  echo "Error: claude-buddy plugin not found." >&2
  echo "" >&2
  echo "Install it first in Claude Code:" >&2
  echo "  /plugin marketplace add hir4ta/claude-buddy" >&2
  echo "  /plugin install claude-buddy@claude-buddy" >&2
  exit 1
fi

PLUGIN_DIR=$(dirname "$(dirname "$RUN_SH")")
echo "Plugin found: $PLUGIN_DIR"
echo ""

# Voyage AI status.
if [ -n "$VOYAGE_API_KEY" ]; then
  echo "VOYAGE_API_KEY: set (semantic search enabled)"
else
  echo "VOYAGE_API_KEY: not set (text search fallback)"
  echo "  To enable semantic search, set the key and re-run:"
  echo "  export VOYAGE_API_KEY=pa-xxx && curl -fsSL https://raw.githubusercontent.com/hir4ta/claude-buddy/main/setup.sh | sh"
fi
echo ""

# Run setup (downloads binary + syncs sessions + generates embeddings).
sh "$RUN_SH" setup

echo ""
echo "Done! Restart Claude Code to activate hooks and MCP tools."

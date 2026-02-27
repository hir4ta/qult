#!/bin/sh
set -e

BUDDY_VERSION="0.12.0"
BUDDY_DIR="${HOME}/.claude-buddy"
BUDDY_BIN="${BUDDY_DIR}/bin/claude-buddy"

# Download binary if missing or version mismatch.
if [ ! -f "$BUDDY_BIN" ] || [ "$("$BUDDY_BIN" version 2>/dev/null)" != "claude-buddy ${BUDDY_VERSION}" ]; then
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
  esac
  URL="https://github.com/hir4ta/claude-buddy/releases/download/v${BUDDY_VERSION}/claude-buddy_${OS}_${ARCH}.tar.gz"
  mkdir -p "${BUDDY_DIR}/bin"
  curl -fsSL "$URL" | tar -xz -C "${BUDDY_DIR}/bin" claude-buddy
  chmod +x "$BUDDY_BIN"
fi

exec "$BUDDY_BIN" "$@"

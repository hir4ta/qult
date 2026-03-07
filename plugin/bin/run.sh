#!/bin/sh
# alfred bootstrapper — resolves binary from PATH, cache, or GitHub Releases.
set -e

REPO="hir4ta/claude-alfred"
VERSION="0.45.3"
CACHE_DIR="${HOME}/.alfred/bin"
CACHED_BIN="${CACHE_DIR}/alfred"

# 1. Binary in PATH? (e.g. Homebrew, go install)
if command -v alfred >/dev/null 2>&1; then
  exec alfred "$@"
fi

# 2. Cached binary exists and matches version?
if [ -x "$CACHED_BIN" ]; then
  CACHED_VER=$("$CACHED_BIN" version --short 2>/dev/null || echo "")
  if [ "$CACHED_VER" = "$VERSION" ]; then
    exec "$CACHED_BIN" "$@"
  fi
fi

# 3. Download from GitHub Releases.
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)        ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

URL="https://github.com/${REPO}/releases/download/v${VERSION}/alfred_${OS}_${ARCH}.tar.gz"
mkdir -p "$CACHE_DIR"

if command -v curl >/dev/null 2>&1; then
  curl -sSfL "$URL" | tar xz -C "$CACHE_DIR" alfred
elif command -v wget >/dev/null 2>&1; then
  wget -qO- "$URL" | tar xz -C "$CACHE_DIR" alfred
else
  echo "alfred: curl or wget required to download binary" >&2
  echo "  Install via Homebrew instead: brew install hir4ta/alfred/alfred" >&2
  exit 1
fi

chmod +x "$CACHED_BIN"
exec "$CACHED_BIN" "$@"

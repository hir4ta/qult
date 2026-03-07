#!/bin/sh
# alfred bootstrapper — resolves binary from PATH, cache, or GitHub Releases.
set -e

REPO="hir4ta/claude-alfred"
VERSION="0.48.0"
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
CHECKSUM_URL="https://github.com/${REPO}/releases/download/v${VERSION}/checksums.txt"
mkdir -p "$CACHE_DIR"

DL_DIR=$(mktemp -d)
trap 'rm -rf "$DL_DIR"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -sSfL "$URL" -o "$DL_DIR/alfred.tar.gz"
  curl -sSfL "$CHECKSUM_URL" -o "$DL_DIR/checksums.txt" 2>/dev/null || true
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$DL_DIR/alfred.tar.gz" "$URL"
  wget -qO "$DL_DIR/checksums.txt" "$CHECKSUM_URL" 2>/dev/null || true
else
  echo "alfred: curl or wget required to download binary" >&2
  echo "  Install via Homebrew instead: brew install hir4ta/alfred/alfred" >&2
  exit 1
fi

# Verify checksum if checksums.txt was downloaded and shasum is available.
if [ -s "$DL_DIR/checksums.txt" ] && command -v shasum >/dev/null 2>&1; then
  EXPECTED=$(grep "alfred_${OS}_${ARCH}.tar.gz" "$DL_DIR/checksums.txt" | awk '{print $1}')
  if [ -n "$EXPECTED" ]; then
    ACTUAL=$(shasum -a 256 "$DL_DIR/alfred.tar.gz" | awk '{print $1}')
    if [ "$ACTUAL" != "$EXPECTED" ]; then
      echo "alfred: checksum mismatch (expected ${EXPECTED}, got ${ACTUAL})" >&2
      exit 1
    fi
  fi
fi

tar -xzf "$DL_DIR/alfred.tar.gz" -C "$CACHE_DIR" alfred
chmod +x "$CACHED_BIN"
exec "$CACHED_BIN" "$@"

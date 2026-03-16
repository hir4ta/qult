#!/bin/sh
# alfred bootstrapper — resolves binary from PATH, cache, or GitHub Releases.
set -e

REPO="hir4ta/claude-alfred"
VERSION="0.73.0"
CACHE_DIR="${HOME}/.alfred/bin"
CACHED_BIN="${CACHE_DIR}/alfred"

# version_gte checks if ver1 >= ver2 using sort -V (version sort).
# Accepts any version string (semver, pseudo-versions, "dev").
version_gte() {
  [ "$1" = "$2" ] && return 0
  # Use sort -V: if $2 sorts first (or equal), then $1 >= $2
  printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1 | grep -qx "$2"
}

# 1. Binary in PATH? (e.g. go install)
if command -v alfred >/dev/null 2>&1; then
  PATH_VER=$(alfred version --short 2>/dev/null || echo "")
  # Strip build metadata (+dirty, +dev, etc.) for comparison
  PATH_VER_BASE="${PATH_VER%%+*}"
  if [ "$PATH_VER" = "dev" ] || version_gte "$PATH_VER_BASE" "$VERSION"; then
    exec alfred "$@"
  fi
fi

# 2. Cached binary exists and matches version?
if [ -x "$CACHED_BIN" ]; then
  CACHED_VER=$("$CACHED_BIN" version --short 2>/dev/null || echo "")
  CACHED_VER_BASE="${CACHED_VER%%+*}"
  if version_gte "$CACHED_VER_BASE" "$VERSION"; then
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

RELEASE_URL="https://github.com/${REPO}/releases/tag/v${VERSION}"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/alfred_${OS}_${ARCH}.tar.gz"
CHECKSUM_URL="https://github.com/${REPO}/releases/download/v${VERSION}/checksums.txt"
mkdir -p "$CACHE_DIR"

DL_DIR=$(mktemp -d)
trap 'rm -rf "$DL_DIR"' EXIT

if command -v curl >/dev/null 2>&1; then
  DL_CMD="curl"
elif command -v wget >/dev/null 2>&1; then
  DL_CMD="wget"
else
  echo "alfred: curl or wget required to download binary" >&2
  exit 1
fi

# Download binary and checksums with clear error on failure.
if [ "$DL_CMD" = "curl" ]; then
  if ! curl -sSfL "$URL" -o "$DL_DIR/alfred.tar.gz" 2>/dev/null; then
    echo "alfred: failed to download v${VERSION} binary" >&2
    echo "  Release may not exist yet: ${RELEASE_URL}" >&2
    echo "  Please try again in a few minutes, or report the issue:" >&2
    echo "  https://github.com/${REPO}/issues" >&2
    exit 1
  fi
  curl -sSfL "$CHECKSUM_URL" -o "$DL_DIR/checksums.txt"
else
  if ! wget -qO "$DL_DIR/alfred.tar.gz" "$URL" 2>/dev/null; then
    echo "alfred: failed to download v${VERSION} binary" >&2
    echo "  Release may not exist yet: ${RELEASE_URL}" >&2
    echo "  Please try again in a few minutes, or report the issue:" >&2
    echo "  https://github.com/${REPO}/issues" >&2
    exit 1
  fi
  wget -qO "$DL_DIR/checksums.txt" "$CHECKSUM_URL"
fi

# Verify checksum (required for binary integrity).
if command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
else
  echo "alfred: shasum or sha256sum not found — cannot verify binary integrity" >&2
  exit 1
fi
EXPECTED=$(grep "alfred_${OS}_${ARCH}.tar.gz" "$DL_DIR/checksums.txt" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
  echo "alfred: no checksum found for alfred_${OS}_${ARCH}.tar.gz" >&2
  exit 1
fi
ACTUAL=$($SHA_CMD "$DL_DIR/alfred.tar.gz" | awk '{print $1}')
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "alfred: checksum mismatch (expected ${EXPECTED}, got ${ACTUAL})" >&2
  exit 1
fi

tar -xzf "$DL_DIR/alfred.tar.gz" -C "$CACHE_DIR" alfred
chmod +x "$CACHED_BIN"
exec "$CACHED_BIN" "$@"

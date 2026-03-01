#!/bin/sh
set -e

# alfred installer — downloads binary and runs setup.
# Usage: curl -fsSL https://raw.githubusercontent.com/hir4ta/claude-alfred/main/install.sh | sh

REPO="hir4ta/claude-alfred"
BIN_DIR="$HOME/.local/bin"

main() {
  echo "Installing alfred..."

  # Detect platform.
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
  esac

  # Get latest version from GitHub API.
  if command -v curl >/dev/null 2>&1; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')
  elif command -v wget >/dev/null 2>&1; then
    VERSION=$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')
  else
    echo "Error: curl or wget is required." >&2
    exit 1
  fi

  if [ -z "$VERSION" ]; then
    echo "Error: could not determine latest version." >&2
    exit 1
  fi

  echo "  Version:  v${VERSION}"
  echo "  Platform: ${OS}/${ARCH}"

  # Download and extract.
  URL="https://github.com/${REPO}/releases/download/v${VERSION}/alfred_${OS}_${ARCH}.tar.gz"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT

  echo "  Downloading..."
  if ! curl -fsSL --retry 2 --max-time 60 "$URL" -o "$TMP/alfred.tar.gz" 2>/dev/null; then
    echo "Error: download failed." >&2
    echo "  URL: $URL" >&2
    exit 1
  fi

  tar -xzf "$TMP/alfred.tar.gz" -C "$TMP" alfred
  chmod +x "$TMP/alfred"

  # Install binary.
  mkdir -p "$BIN_DIR"
  mv -f "$TMP/alfred" "$BIN_DIR/alfred"
  echo "✓ Binary installed to ${BIN_DIR}/alfred"

  # Check PATH.
  case ":$PATH:" in
    *":${BIN_DIR}:"*)
      ;;
    *)
      echo ""
      echo "⚠ ${BIN_DIR} is not in your PATH. Add it:"
      echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      echo ""
      # Temporarily add to PATH for this script.
      export PATH="${BIN_DIR}:${PATH}"
      ;;
  esac

  # Run setup.
  "$BIN_DIR/alfred" install "$@"
}

main "$@"

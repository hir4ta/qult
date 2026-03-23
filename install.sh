#!/bin/bash
set -euo pipefail

# alfred installer — downloads the latest binary and sets up the environment.
# Usage: curl -fsSL https://raw.githubusercontent.com/hir4ta/claude-alfred/main/install.sh | bash

REPO="hir4ta/claude-alfred"
INSTALL_DIR="${HOME}/.local/bin"
ALFRED_DIR="${HOME}/.claude-alfred"

# Detect OS and architecture
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)      echo "Unsupported OS: $os" >&2; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)             echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac

  echo "${os}-${arch}"
}

# Get latest release tag from GitHub
get_latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
}

main() {
  local platform version url

  platform="$(detect_platform)"
  echo "Detected platform: ${platform}"

  echo "Fetching latest version..."
  version="$(get_latest_version)"
  echo "Latest version: ${version}"

  url="https://github.com/${REPO}/releases/download/${version}/alfred-${platform}"

  # Download binary
  echo "Downloading alfred ${version} for ${platform}..."
  mkdir -p "${INSTALL_DIR}"
  curl -fsSL "${url}" -o "${INSTALL_DIR}/alfred"
  chmod +x "${INSTALL_DIR}/alfred"

  # Setup database and rules
  echo "Setting up alfred..."
  "${INSTALL_DIR}/alfred" doctor 2>/dev/null || true

  # Ensure ~/.local/bin is in PATH
  if ! echo "$PATH" | grep -q "${INSTALL_DIR}"; then
    local shell_rc=""
    case "$(basename "$SHELL")" in
      zsh)  shell_rc="${HOME}/.zshrc" ;;
      bash) shell_rc="${HOME}/.bashrc" ;;
      fish) shell_rc="${HOME}/.config/fish/config.fish" ;;
    esac
    if [ -n "$shell_rc" ]; then
      echo "" >> "$shell_rc"
      echo "# alfred" >> "$shell_rc"
      echo "export PATH=\"${INSTALL_DIR}:\$PATH\"" >> "$shell_rc"
      echo "Added ${INSTALL_DIR} to PATH in ${shell_rc}"
    fi
  fi

  echo ""
  echo "✓ alfred ${version} installed to ${INSTALL_DIR}/alfred"
  echo ""
  echo "Next steps:"
  echo "  1. Restart your shell or run: export PATH=\"${INSTALL_DIR}:\$PATH\""
  echo "  2. (Optional) Add to ~/.zshrc: export VOYAGE_API_KEY=your-key"
  echo "  3. In Claude Code:"
  echo "     /plugin marketplace add ${REPO}"
  echo "     /plugin install alfred"
  echo "  4. Restart Claude Code"
  echo ""
  echo "Commands:"
  echo "  alfred dashboard    # Web dashboard"
  echo "  alfred tui          # Terminal progress viewer"
  echo "  alfred doctor       # Check installation"
}

main

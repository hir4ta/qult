#!/bin/sh
# qult installer — downloads pre-built binary from GitHub Releases
# Usage: curl -fsSL https://raw.githubusercontent.com/user/qult/main/install.sh | bash
#
# Options (via env vars):
#   QULT_VERSION=v0.15.0    Pin specific version (default: latest)
#   QULT_INSTALL_DIR=~/.bin  Override install directory (default: ~/.local/bin)

set -eu

REPO="user/qult"
INSTALL_DIR="${QULT_INSTALL_DIR:-$HOME/.local/bin}"

# --- Platform detection ---

detect_platform() {
	OS="$(uname -s)"
	ARCH="$(uname -m)"

	case "$OS" in
		Darwin) OS="darwin" ;;
		Linux)  OS="linux" ;;
		*)
			echo "Error: Unsupported OS: $OS" >&2
			exit 1
			;;
	esac

	case "$ARCH" in
		x86_64|amd64)  ARCH="x64" ;;
		arm64|aarch64) ARCH="arm64" ;;
		*)
			echo "Error: Unsupported architecture: $ARCH" >&2
			exit 1
			;;
	esac

	# Rosetta 2 detection: if running x64 under ARM, switch to arm64
	if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
		if sysctl -n sysctl.proc_translated 2>/dev/null | grep -q 1; then
			ARCH="arm64"
		fi
	fi

	# musl detection for Alpine Linux
	if [ "$OS" = "linux" ]; then
		if ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; then
			ARCH="${ARCH}-musl"
		fi
	fi

	PLATFORM="${OS}-${ARCH}"
}

# --- Version resolution ---

resolve_version() {
	if [ -n "${QULT_VERSION:-}" ]; then
		VERSION="$QULT_VERSION"
		return
	fi

	echo "Fetching latest version..."
	if command -v curl >/dev/null 2>&1; then
		VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"tag_name":\s*"([^"]+)".*/\1/')"
	elif command -v wget >/dev/null 2>&1; then
		VERSION="$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"tag_name":\s*"([^"]+)".*/\1/')"
	else
		echo "Error: curl or wget required" >&2
		exit 1
	fi

	if [ -z "$VERSION" ]; then
		echo "Error: Could not determine latest version" >&2
		exit 1
	fi
}

# --- Download + verify ---

download_and_verify() {
	ARTIFACT="qult-${PLATFORM}.tar.gz"
	URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARTIFACT}"
	CHECKSUM_URL="${URL}.sha256"

	TMPDIR="$(mktemp -d)"
	trap 'rm -rf "$TMPDIR"' EXIT

	echo "Downloading qult ${VERSION} for ${PLATFORM}..."

	# Download binary archive
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "${TMPDIR}/${ARTIFACT}" "$URL"
		curl -fsSL -o "${TMPDIR}/${ARTIFACT}.sha256" "$CHECKSUM_URL"
	else
		wget -q -O "${TMPDIR}/${ARTIFACT}" "$URL"
		wget -q -O "${TMPDIR}/${ARTIFACT}.sha256" "$CHECKSUM_URL"
	fi

	# Verify checksum
	echo "Verifying checksum..."
	EXPECTED="$(cat "${TMPDIR}/${ARTIFACT}.sha256" | awk '{print $1}')"
	if command -v shasum >/dev/null 2>&1; then
		ACTUAL="$(shasum -a 256 "${TMPDIR}/${ARTIFACT}" | awk '{print $1}')"
	elif command -v sha256sum >/dev/null 2>&1; then
		ACTUAL="$(sha256sum "${TMPDIR}/${ARTIFACT}" | awk '{print $1}')"
	else
		echo "Warning: No checksum tool found, skipping verification" >&2
		ACTUAL="$EXPECTED"
	fi

	if [ "$EXPECTED" != "$ACTUAL" ]; then
		echo "Error: Checksum mismatch" >&2
		echo "  Expected: $EXPECTED" >&2
		echo "  Actual:   $ACTUAL" >&2
		exit 1
	fi

	# Extract
	tar xzf "${TMPDIR}/${ARTIFACT}" -C "${TMPDIR}"
}

# --- Install ---

install_binary() {
	mkdir -p "$INSTALL_DIR"
	mv "${TMPDIR}/qult" "${INSTALL_DIR}/qult"
	chmod +x "${INSTALL_DIR}/qult"
	echo "Installed qult to ${INSTALL_DIR}/qult"
}

# --- PATH setup ---

setup_path() {
	case ":${PATH}:" in
		*":${INSTALL_DIR}:"*) return ;; # Already in PATH
	esac

	echo ""
	echo "Adding ${INSTALL_DIR} to PATH..."

	SHELL_NAME="$(basename "${SHELL:-/bin/sh}")"
	PROFILE=""

	case "$SHELL_NAME" in
		zsh)
			PROFILE="$HOME/.zshrc"
			;;
		bash)
			if [ -f "$HOME/.bashrc" ]; then
				PROFILE="$HOME/.bashrc"
			elif [ -f "$HOME/.bash_profile" ]; then
				PROFILE="$HOME/.bash_profile"
			else
				PROFILE="$HOME/.profile"
			fi
			;;
		fish)
			PROFILE="$HOME/.config/fish/config.fish"
			;;
		*)
			PROFILE="$HOME/.profile"
			;;
	esac

	if [ -n "$PROFILE" ]; then
		if [ "$SHELL_NAME" = "fish" ]; then
			echo "set -gx PATH \"${INSTALL_DIR}\" \$PATH" >> "$PROFILE"
		else
			echo "export PATH=\"${INSTALL_DIR}:\$PATH\"" >> "$PROFILE"
		fi
		echo "  Added to $PROFILE"
		echo "  Run: source $PROFILE (or restart your shell)"
	fi
}

# --- Main ---

main() {
	detect_platform
	resolve_version
	download_and_verify
	install_binary
	setup_path

	echo ""
	echo "qult ${VERSION} installed successfully!"
	echo ""
	echo "Next steps:"
	echo "  cd your-project"
	echo "  qult init    # Set up hooks + auto-detect gates"
	echo "  qult doctor  # Verify installation"
}

main "$@"

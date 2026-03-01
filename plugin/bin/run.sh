#!/bin/sh
# claude-alfred wrapper — auto-downloads binary on version mismatch.
ALFRED_VERSION="dev"
BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
ALFRED_BIN="${BIN_DIR}/claude-alfred"
VERSION_FILE="${BIN_DIR}/.alfred-version"
LOCK_DIR="${BIN_DIR}/.alfred-download.lock"
INSTALL_MARKER="${BIN_DIR}/.alfred-installed-${ALFRED_VERSION}"
INSTALL_LOCK="${BIN_DIR}/.alfred-install.lock"

# --- helpers ----------------------------------------------------------------

is_current() {
  [ -f "$ALFRED_BIN" ] && [ -f "$VERSION_FILE" ] && \
    [ "$(cat "$VERSION_FILE" 2>/dev/null)" = "$ALFRED_VERSION" ]
}

detect_platform() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
  esac
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "${LOCK_DIR}/pid"
    return 0
  fi
  # Check for stale lock (owner process dead).
  if [ -f "${LOCK_DIR}/pid" ]; then
    LOCK_PID=$(cat "${LOCK_DIR}/pid" 2>/dev/null)
    if [ -n "$LOCK_PID" ] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
      rm -rf "$LOCK_DIR"
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo $$ > "${LOCK_DIR}/pid"
        return 0
      fi
    fi
  fi
  return 1
}

release_lock() { rm -rf "$LOCK_DIR"; }

download_binary() {
  detect_platform
  URL="https://github.com/hir4ta/claude-alfred/releases/download/v${ALFRED_VERSION}/claude-alfred_${OS}_${ARCH}.tar.gz"
  TMP_TAR="${BIN_DIR}/.alfred-dl.$$.tar.gz"
  TMP_EXTRACT="${BIN_DIR}/.alfred-dl.$$"

  # Download tarball.
  if ! curl -fsSL --retry 2 --max-time 60 "$URL" -o "$TMP_TAR" 2>/dev/null; then
    rm -f "$TMP_TAR"
    return 1
  fi

  # Extract to temp dir, then move atomically.
  mkdir -p "$TMP_EXTRACT"
  if ! tar -xzf "$TMP_TAR" -C "$TMP_EXTRACT" claude-alfred 2>/dev/null; then
    rm -f "$TMP_TAR"; rm -rf "$TMP_EXTRACT"
    return 1
  fi
  chmod +x "${TMP_EXTRACT}/claude-alfred"
  mv -f "${TMP_EXTRACT}/claude-alfred" "$ALFRED_BIN"
  printf '%s' "$ALFRED_VERSION" > "$VERSION_FILE"
  rm -f "$TMP_TAR"; rm -rf "$TMP_EXTRACT"
  return 0
}

# Try to ensure binary is current.  Returns 0 if binary is usable.
ensure_binary() {
  is_current && return 0

  if acquire_lock; then
    download_binary
    DL_RC=$?
    release_lock
    [ $DL_RC -eq 0 ] && return 0
  else
    # Another process is downloading — wait briefly.
    WAIT=0
    while [ $WAIT -lt "$1" ]; do
      sleep 1
      is_current && return 0
      WAIT=$((WAIT + 1))
    done
  fi

  # Fallback: use old binary if it exists (version mismatch but functional).
  [ -f "$ALFRED_BIN" ] && return 0
  return 1
}

# --- main dispatch ----------------------------------------------------------

case "$1" in
  setup)
    # Explicit first-time setup (called from curl one-liner).
    if is_current; then
      echo "claude-alfred ${ALFRED_VERSION} already installed"
    else
      if acquire_lock; then
        download_binary || { release_lock; echo "Download failed." >&2; exit 1; }
        release_lock
      else
        echo "Another download in progress. Waiting..." >&2
        WAIT=0
        while [ $WAIT -lt 60 ]; do
          sleep 1; is_current && break; WAIT=$((WAIT + 1))
        done
        is_current || { echo "Download timed out." >&2; exit 1; }
      fi
      echo "claude-alfred ${ALFRED_VERSION} installed"
    fi
    shift
    exec "$ALFRED_BIN" install "$@"
    ;;

  count-sessions)
    # Quick session count — no sync, just directory scan.
    if ! ensure_binary 30; then
      echo '{"error":"binary not available"}' >&2
      exit 1
    fi
    exec "$ALFRED_BIN" count-sessions
    ;;

  serve)
    # MCP server — no timeout, block until binary ready.
    if ! ensure_binary 60; then
      echo "claude-alfred: binary not available. Run setup first." >&2
      exit 1
    fi
    # Run install in background on first serve after download.
    # Use mkdir as atomic lock to prevent concurrent install processes.
    # Clean stale lock (owner process dead).
    if [ -d "$INSTALL_LOCK" ] && [ -f "$INSTALL_LOCK/pid" ]; then
      INST_PID=$(cat "$INSTALL_LOCK/pid" 2>/dev/null)
      if [ -n "$INST_PID" ] && ! kill -0 "$INST_PID" 2>/dev/null; then
        rm -rf "$INSTALL_LOCK"
      fi
    fi
    if [ ! -f "$INSTALL_MARKER" ] && mkdir "$INSTALL_LOCK" 2>/dev/null; then
      ( echo $$ > "$INSTALL_LOCK/pid"
        "$ALFRED_BIN" install >/dev/null 2>&1
        printf '%s' "$ALFRED_VERSION" > "$INSTALL_MARKER"
        rm -rf "$INSTALL_LOCK" ) &
    fi
    exec "$ALFRED_BIN" serve
    ;;

  hook)
    # Hooks have tight timeouts (1-8s). Try briefly, then degrade silently.
    if ! ensure_binary 3; then
      exit 0
    fi
    exec "$ALFRED_BIN" "$@"
    ;;

  version|--version|-v)
    if is_current; then
      exec "$ALFRED_BIN" version
    fi
    echo "claude-alfred ${ALFRED_VERSION} (binary not yet downloaded)"
    ;;

  *)
    if ! ensure_binary 30; then
      echo "claude-alfred: binary not available. Run setup first." >&2
      exit 1
    fi
    exec "$ALFRED_BIN" "$@"
    ;;
esac

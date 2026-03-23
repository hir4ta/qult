#!/bin/bash
set -euo pipefail

# Build single-file executables for all supported platforms.
# Requires Bun 1.3+

OUT_DIR="dist/binaries"
ENTRY="dist/cli.mjs"

mkdir -p "$OUT_DIR"

# First, build the JS bundle (tsdown)
echo "Building JS bundle..."
bun run build

TARGETS=(
  "bun-darwin-arm64"
  "bun-darwin-x64"
  "bun-linux-arm64"
  "bun-linux-x64"
)

for target in "${TARGETS[@]}"; do
  # Extract platform name for output: bun-darwin-arm64 → darwin-arm64
  platform="${target#bun-}"
  outfile="${OUT_DIR}/alfred-${platform}"

  echo "Compiling for ${platform}..."
  bun build "$ENTRY" \
    --compile \
    --minify \
    --target="$target" \
    --outfile="$outfile"

  echo "  → ${outfile} ($(du -h "$outfile" | cut -f1))"
done

echo ""
echo "All binaries built in ${OUT_DIR}/"
ls -lh "$OUT_DIR"/

#!/usr/bin/env bash
# Build the ikenga-mbox sidecar into a self-contained binary for Tauri's externalBin.
#
# Tauri expects the binary to be named "<basename>-<target-triple>", e.g.
#   ikenga-mbox-x86_64-unknown-linux-gnu
#   ikenga-mbox-aarch64-apple-darwin
# The basename is referenced from tauri.conf.json -> bundle.externalBin.

set -euo pipefail

cd "$(dirname "$0")"

TARGET="${1:-$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')}"
if [[ -z "${TARGET:-}" ]]; then
  echo "error: could not infer target triple; pass it as arg 1" >&2
  echo "  e.g. ./build.sh x86_64-unknown-linux-gnu" >&2
  exit 1
fi

# Map rust triple -> bun --target
case "$TARGET" in
  x86_64-unknown-linux-gnu)   BUN_TARGET="bun-linux-x64" ;;
  aarch64-unknown-linux-gnu)  BUN_TARGET="bun-linux-arm64" ;;
  x86_64-apple-darwin)        BUN_TARGET="bun-darwin-x64" ;;
  aarch64-apple-darwin)       BUN_TARGET="bun-darwin-arm64" ;;
  x86_64-pc-windows-msvc)     BUN_TARGET="bun-windows-x64" ;;
  *)
    echo "error: unsupported target triple: $TARGET" >&2
    exit 1
    ;;
esac

mkdir -p dist
OUTPUT="dist/ikenga-mbox-${TARGET}"

echo "==> building $OUTPUT (bun target: $BUN_TARGET)"
bun build --compile --target="$BUN_TARGET" --minify src/sidecar.ts --outfile "$OUTPUT"

# Tauri sidecar must be executable
chmod +x "$OUTPUT"

echo "==> done: $(du -h "$OUTPUT" | cut -f1) $OUTPUT"

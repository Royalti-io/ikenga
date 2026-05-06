#!/usr/bin/env bash
# Build ikenga-actions sidecar — bun-compiled binary for Tauri externalBin AND
# direct cron invocation. The same binary serves both:
#   - Tauri shell.sidecar(...) at runtime (live mode)
#   - .sh wrappers in scripts/cron/ikenga-actions/ (cron one-shots)
#
# Tauri expects "<basename>-<target-triple>"; cron wrappers symlink to
# dist/ikenga-actions (no triple suffix) for ergonomic invocation.

set -euo pipefail

cd "$(dirname "$0")"

TARGET="${1:-$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')}"
if [[ -z "${TARGET:-}" ]]; then
  echo "error: could not infer target triple; pass it as arg 1" >&2
  exit 1
fi

case "$TARGET" in
  x86_64-unknown-linux-gnu)   BUN_TARGET="bun-linux-x64" ;;
  aarch64-unknown-linux-gnu)  BUN_TARGET="bun-linux-arm64" ;;
  x86_64-apple-darwin)        BUN_TARGET="bun-darwin-x64" ;;
  aarch64-apple-darwin)       BUN_TARGET="bun-darwin-arm64" ;;
  x86_64-pc-windows-msvc)     BUN_TARGET="bun-windows-x64" ;;
  *) echo "error: unsupported target triple: $TARGET" >&2; exit 1 ;;
esac

mkdir -p dist
OUTPUT="dist/ikenga-actions-${TARGET}"

echo "==> building $OUTPUT (bun target: $BUN_TARGET)"
bun build --compile --target="$BUN_TARGET" --minify src/main.ts --outfile "$OUTPUT"
chmod +x "$OUTPUT"

# Symlink for cron ergonomics: dist/ikenga-actions -> dist/ikenga-actions-<triple>
ln -sf "ikenga-actions-${TARGET}" "dist/ikenga-actions"

echo "==> done: $(du -h "$OUTPUT" | cut -f1) $OUTPUT"
echo "    cron alias: dist/ikenga-actions"

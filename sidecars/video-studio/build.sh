#!/usr/bin/env bash
# Build the pa-video-studio sidecar into a self-contained binary for Tauri's externalBin.
#
# The binary is a thin shim: it allocates a free port, spawns Remotion Studio's
# CLI from the desktop app's node_modules as a child process, and emits a
# `ready` frame on stdout once the studio is listening. See README.md.
#
# Tauri expects the binary to be named "<basename>-<target-triple>", e.g.
#   pa-video-studio-x86_64-unknown-linux-gnu
#   pa-video-studio-aarch64-apple-darwin

set -euo pipefail

cd "$(dirname "$0")"

TARGET="${1:-$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')}"
if [[ -z "${TARGET:-}" ]]; then
  echo "error: could not infer target triple; pass it as arg 1" >&2
  echo "  e.g. ./build.sh x86_64-unknown-linux-gnu" >&2
  exit 1
fi

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
OUTPUT="dist/pa-video-studio-${TARGET}"

echo "==> building $OUTPUT (bun target: $BUN_TARGET)"
bun build --compile --target="$BUN_TARGET" --minify src/sidecar.ts --outfile "$OUTPUT"

chmod +x "$OUTPUT"

echo "==> done: $(du -h "$OUTPUT" | cut -f1) $OUTPUT"

# Wire the binary into the com.royalti.video-studio pkg fixture for the
# /iframe-mount-smoke?phase=video-studio smoke. Same dev-only convention
# as sidecars/hyperframes/build.sh.
FIXTURE_DIR="/tmp/test-pkg-com.royalti.video-studio"
if [[ -d "$FIXTURE_DIR" ]]; then
  mkdir -p "$FIXTURE_DIR/sidecars"
  cp "$OUTPUT" "$FIXTURE_DIR/sidecars/pa-video-studio"
  chmod +x "$FIXTURE_DIR/sidecars/pa-video-studio"
  echo "==> wired into $FIXTURE_DIR/sidecars/pa-video-studio"
fi

# Wire the binary into the builtin-pkgs directory so the kernel auto-installs
# com.royalti.video-studio on app boot. Bundled into the app image via
# tauri.conf.json bundle.resources glob (resources/builtin-pkgs/**/*).
BUILTIN_DIR="../../src-tauri/resources/builtin-pkgs/com.royalti.video-studio"
if [[ -d "$BUILTIN_DIR" ]]; then
  mkdir -p "$BUILTIN_DIR/sidecars"
  cp "$OUTPUT" "$BUILTIN_DIR/sidecars/pa-video-studio"
  chmod +x "$BUILTIN_DIR/sidecars/pa-video-studio"
  echo "==> wired into $BUILTIN_DIR/sidecars/pa-video-studio"
fi

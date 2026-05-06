#!/usr/bin/env bash
# Build the pa-storyboard sidecar binary for Tauri's externalBin. See README.md.

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
  *)
    echo "error: unsupported target triple: $TARGET" >&2
    exit 1
    ;;
esac

mkdir -p dist
OUTPUT="dist/pa-storyboard-${TARGET}"

echo "==> building $OUTPUT (bun target: $BUN_TARGET)"
bun build --compile --target="$BUN_TARGET" --minify src/sidecar.ts --outfile "$OUTPUT"

chmod +x "$OUTPUT"

echo "==> done: $(du -h "$OUTPUT" | cut -f1) $OUTPUT"

# Wire the binary into the com.royalti.storyboard pkg fixture for the
# /iframe-mount-smoke?phase=storyboard smoke. Same dev-only convention
# as sidecars/hyperframes/build.sh and sidecars/video-studio/build.sh.
FIXTURE_DIR="/tmp/test-pkg-com.royalti.storyboard"
if [[ -d "$FIXTURE_DIR" ]]; then
  mkdir -p "$FIXTURE_DIR/sidecars"
  cp "$OUTPUT" "$FIXTURE_DIR/sidecars/pa-storyboard"
  chmod +x "$FIXTURE_DIR/sidecars/pa-storyboard"
  echo "==> wired into $FIXTURE_DIR/sidecars/pa-storyboard"
fi
# Wire the binary into the builtin-pkgs directory so the kernel auto-installs
# com.royalti.storyboard on app boot. Bundled into the app image via
# tauri.conf.json bundle.resources glob (resources/builtin-pkgs/**/*).
BUILTIN_DIR="../../src-tauri/resources/builtin-pkgs/com.royalti.storyboard"
if [[ -d "$BUILTIN_DIR" ]]; then
  mkdir -p "$BUILTIN_DIR/sidecars"
  cp "$OUTPUT" "$BUILTIN_DIR/sidecars/pa-storyboard"
  chmod +x "$BUILTIN_DIR/sidecars/pa-storyboard"
  echo "==> wired into $BUILTIN_DIR/sidecars/pa-storyboard"
fi

#!/usr/bin/env bash
# Build the pa-hyperframes sidecar binary for Tauri's externalBin. See README.md.

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
OUTPUT="dist/pa-hyperframes-${TARGET}"

echo "==> building $OUTPUT (bun target: $BUN_TARGET)"
bun build --compile --target="$BUN_TARGET" --minify src/sidecar.ts --outfile "$OUTPUT"

chmod +x "$OUTPUT"

echo "==> done: $(du -h "$OUTPUT" | cut -f1) $OUTPUT"

# ── Wrapper UI (PR 3) ──────────────────────────────────────────────────────
# The pkg's iframe-served document lives in `wrapper/` as a Vite project.
# Build it on every binary build so the fixture's dist/ stays in sync with
# whatever ships in the binary. Skipped if `wrapper/` was deleted (e.g. on
# a future PR that vendors the bundled output instead).
if [[ -d "wrapper" ]]; then
  echo "==> building wrapper UI"
  pushd wrapper >/dev/null
  if [[ ! -d node_modules ]]; then
    bun install
  fi
  bunx vite build
  popd >/dev/null
  echo "==> wrapper built: wrapper/dist/"
fi

# Wire the binary + wrapper into the com.royalti.hyperframes pkg fixture
# used by the /iframe-mount-smoke?phase=hyperframes smoke. The fixture
# lives under /tmp so it follows the same convention as
# com.example.iframeapp / longlived. This is dev-only — a production
# package install will lay these files down via the catalog/install flow.
FIXTURE_DIR="/tmp/test-pkg-com.royalti.hyperframes"
if [[ -d "$FIXTURE_DIR" ]]; then
  mkdir -p "$FIXTURE_DIR/sidecars"
  cp "$OUTPUT" "$FIXTURE_DIR/sidecars/pa-hyperframes"
  chmod +x "$FIXTURE_DIR/sidecars/pa-hyperframes"
  echo "==> wired binary into $FIXTURE_DIR/sidecars/pa-hyperframes"

  if [[ -d "wrapper/dist" ]]; then
    rm -rf "$FIXTURE_DIR/dist"
    mkdir -p "$FIXTURE_DIR/dist"
    cp -r wrapper/dist/. "$FIXTURE_DIR/dist/"
    echo "==> wired wrapper into $FIXTURE_DIR/dist/"
  fi
fi

# Wire the binary + wrapper into the builtin-pkgs directory so the kernel
# auto-installs com.royalti.hyperframes on app boot. Bundled into the app
# image via tauri.conf.json bundle.resources glob (resources/builtin-pkgs/**/*).
BUILTIN_DIR="../../src-tauri/resources/builtin-pkgs/com.royalti.hyperframes"
if [[ -d "$BUILTIN_DIR" ]]; then
  mkdir -p "$BUILTIN_DIR/sidecars"
  cp "$OUTPUT" "$BUILTIN_DIR/sidecars/pa-hyperframes"
  chmod +x "$BUILTIN_DIR/sidecars/pa-hyperframes"
  echo "==> wired binary into $BUILTIN_DIR/sidecars/pa-hyperframes"

  if [[ -d "wrapper/dist" ]]; then
    rm -rf "$BUILTIN_DIR/dist"
    mkdir -p "$BUILTIN_DIR/dist"
    cp -r wrapper/dist/. "$BUILTIN_DIR/dist/"
    echo "==> wired wrapper into $BUILTIN_DIR/dist/"
  fi
fi

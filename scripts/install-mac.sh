#!/usr/bin/env bash
# Personal-use installer for macOS. Unsigned, ad-hoc-signed by Tauri.
# Drag-equivalent: copy .app to /Applications, strip the quarantine bit so
# Gatekeeper doesn't block first launch, then open it.
#
# Build first (Apple Silicon only, per Phase 8):
#   cd ikenga-desktop
#   bunx tauri build --target aarch64-apple-darwin
#
# Then run this script from the ikenga-desktop dir.

set -euo pipefail

APP_NAME="Ikenga"
TARGET="${TAURI_TARGET:-aarch64-apple-darwin}"
BUNDLE_DIR="src-tauri/target/${TARGET}/release/bundle/macos"
SRC="${BUNDLE_DIR}/${APP_NAME}.app"
DEST="/Applications/${APP_NAME}.app"

if [[ ! -d "$SRC" ]]; then
  echo "error: ${SRC} not found." >&2
  echo "       run \`bunx tauri build --target ${TARGET}\` first." >&2
  exit 1
fi

if [[ -d "$DEST" ]]; then
  echo "removing existing ${DEST}"
  rm -rf "$DEST"
fi

echo "copying ${SRC} -> ${DEST}"
cp -R "$SRC" "$DEST"

echo "clearing quarantine attribute"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo
echo "installed. launch with:"
echo "  open \"$DEST\""
echo
echo "or find it in Spotlight / Launchpad."

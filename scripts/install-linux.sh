#!/usr/bin/env bash
# Personal-use installer for Linux. Copies the AppImage to ~/Applications/,
# makes it executable, drops a .desktop file so the launcher / file manager
# can find it.
#
# Build first:
#   cd ikenga-desktop
#   bunx tauri build --target x86_64-unknown-linux-gnu
#
# .deb fallback (system-managed):
#   sudo dpkg -i src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/ikenga_*.deb

set -euo pipefail

TARGET="${TAURI_TARGET:-x86_64-unknown-linux-gnu}"
APPIMAGE_GLOB="src-tauri/target/${TARGET}/release/bundle/appimage/Ikenga_*.AppImage"
APP_DIR="${HOME}/Applications"
INSTALLED="${APP_DIR}/ikenga.AppImage"
DESKTOP_SRC="assets/linux/ikenga.desktop"
DESKTOP_DIR="${HOME}/.local/share/applications"
DESKTOP_DEST="${DESKTOP_DIR}/ikenga.desktop"

# shellcheck disable=SC2206
matches=( $APPIMAGE_GLOB )
if [[ ! -e "${matches[0]}" ]]; then
  echo "error: no AppImage found matching ${APPIMAGE_GLOB}" >&2
  echo "       run \`bunx tauri build --target ${TARGET}\` first." >&2
  exit 1
fi
SRC="${matches[0]}"

mkdir -p "$APP_DIR" "$DESKTOP_DIR"

echo "copying ${SRC} -> ${INSTALLED}"
cp -f "$SRC" "$INSTALLED"
chmod +x "$INSTALLED"

if [[ -f "$DESKTOP_SRC" ]]; then
  echo "installing desktop entry -> ${DESKTOP_DEST}"
  # Substitute %EXEC% so the .desktop file's Exec line points at the installed AppImage.
  sed "s|%EXEC%|${INSTALLED}|g" "$DESKTOP_SRC" > "$DESKTOP_DEST"
  chmod 644 "$DESKTOP_DEST"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" || true
  fi
fi

echo
echo "installed. launch with:"
echo "  ${INSTALLED}"
echo
echo "or find \"Ikenga\" in your application launcher."

#!/usr/bin/env bash
# Personal-use installer for Linux. Wraps `dpkg -i` against the .deb that
# `bunx tauri build` produces. AppImage was the original primary path but
# linuxdeploy chokes on the bundled bun-compiled iyke-mcp binary
# (self-contained ELF that ldd can't parse), so .deb is the supported
# install path until the AppImage tooling is fixed.
#
# Build first:
#   cd ikenga/shell
#   bunx tauri build --target x86_64-unknown-linux-gnu
#
# Requires sudo to invoke dpkg. The install lands the binary at
# /usr/bin/ikenga-desktop and the .desktop entry under
# /usr/share/applications/ so the system launcher finds it.

set -euo pipefail

TARGET="${TAURI_TARGET:-x86_64-unknown-linux-gnu}"
DEB_GLOB="src-tauri/target/${TARGET}/release/bundle/deb/Ikenga_*_amd64.deb"

# shellcheck disable=SC2206
matches=( $DEB_GLOB )
if [[ ! -e "${matches[0]}" ]]; then
  echo "error: no .deb found matching ${DEB_GLOB}" >&2
  echo "       run \`bunx tauri build --target ${TARGET}\` first." >&2
  exit 1
fi
DEB="${matches[0]}"

echo "installing ${DEB}…"
sudo dpkg -i "$DEB" || {
  echo
  echo "dpkg reported missing dependencies. Trying \`apt-get install -f\` to resolve…"
  sudo apt-get install -f -y
  sudo dpkg -i "$DEB"
}

echo
echo "installed. launch with:"
echo "  ikenga-desktop"
echo
echo "or find \"Ikenga\" in your application launcher."

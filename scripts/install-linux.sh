#!/usr/bin/env bash
# Personal-use installer for Linux. Wraps `dpkg -i` against the .deb that
# `bunx tauri build` produces. Both .deb and .AppImage build fine — CI ships a
# working signed AppImage every release. This script just covers the .deb
# system-install path (registers with dpkg, lands /usr/bin/ikenga-desktop). For
# a no-root portable install, grab the .AppImage from the GitHub release or the
# local bundle/appimage/ output instead.
#
# Build first:
#   cd ikenga/shell
#   bunx tauri build --target x86_64-unknown-linux-gnu
#
# AppImage build prereq: the .AppImage target runs linuxdeploy's gtk +
# gstreamer plugins (gstreamer is pulled in by tauri.conf.json's
# linux.appimage.bundleMediaFramework). The gstreamer plugin needs `patchelf`
# on PATH or it fails with `Error: patchelf not found` →
# `Failed to run plugin: gstreamer (exit code: 2)` and no .AppImage is emitted.
# CI installs it (see .github/workflows/release.yml). Locally:
#   sudo apt-get install -y patchelf
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

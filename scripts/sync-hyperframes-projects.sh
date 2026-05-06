#!/usr/bin/env bash
# Populate ikenga-desktop/hyperframes-projects/ from the canonical home in
# royalti-video-engine/packages/hyperframes/projects/.
#
# Default mode is symlink (fast, in-sync, dev-friendly). Pass --copy to deep
# copy instead — useful for shipped builds where the desktop app installer
# needs the projects bundled standalone.
#
# The pa-hyperframes sidecar resolves the hyperframes CLI relative to each
# project's *real* path (via realpathSync), so symlinks work transparently.
#
# Usage:
#   ./scripts/sync-hyperframes-projects.sh             # symlink (default)
#   ./scripts/sync-hyperframes-projects.sh --copy      # deep copy
#   ./scripts/sync-hyperframes-projects.sh --clean     # remove and re-sync

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PA_DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$PA_DESKTOP_ROOT/hyperframes-projects"
SOURCE="$(cd "$PA_DESKTOP_ROOT/.." && pwd)/royalti-video-engine/packages/hyperframes/projects"

MODE="symlink"
for arg in "$@"; do
  case "$arg" in
    --copy)   MODE="copy" ;;
    --clean)  rm -rf "$TARGET"; echo "==> removed $TARGET" ;;
    --symlink|"") MODE="symlink" ;;
    *) echo "error: unknown flag $arg" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$SOURCE" ]]; then
  echo "error: source dir not found: $SOURCE" >&2
  echo "  expected royalti-video-engine to be a sibling of ikenga-desktop" >&2
  exit 1
fi

mkdir -p "$TARGET"

echo "==> syncing hyperframes projects ($MODE)"
echo "    source: $SOURCE"
echo "    target: $TARGET"

# Drop entries in TARGET that no longer exist in SOURCE.
if [[ -d "$TARGET" ]]; then
  for entry in "$TARGET"/*; do
    [[ -e "$entry" ]] || continue
    name="$(basename "$entry")"
    if [[ ! -e "$SOURCE/$name" ]]; then
      echo "    - removing stale: $name"
      rm -rf "$entry"
    fi
  done
fi

# Sync each project from SOURCE.
COUNT=0
for src in "$SOURCE"/*/; do
  [[ -d "$src" ]] || continue
  name="$(basename "$src")"
  dst="$TARGET/$name"

  case "$MODE" in
    symlink)
      # Replace whatever is there with a symlink.
      rm -rf "$dst"
      ln -s "$src" "$dst"
      echo "    + symlinked $name"
      ;;
    copy)
      rm -rf "$dst"
      cp -RL "$src" "$dst"
      echo "    + copied $name"
      ;;
  esac
  COUNT=$((COUNT + 1))
done

echo "==> done. ${MODE^}ed $COUNT project(s) under $TARGET"

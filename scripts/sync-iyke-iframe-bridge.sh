#!/usr/bin/env bash
# Sync the canonical iframe bridge from ikenga-desktop to each
# sidecar's src dir. Run after editing
# `src/lib/iyke/iframe-bridge.ts`.
#
# Each sidecar then imports `./iyke-bridge` and calls
# `mountIykeIframeBridge()` once at app startup.

set -euo pipefail

SRC="$(cd "$(dirname "$0")"/.. && pwd)/src/lib/iyke/iframe-bridge.ts"
ROOT="$(cd "$(dirname "$0")"/../.. && pwd)"

if [[ ! -f "$SRC" ]]; then
  echo "error: bridge source not found at $SRC" >&2
  exit 1
fi

DESTS=(
  "$ROOT/royalti-video-engine/storyboard-app/src/iyke-bridge.ts"
  "$ROOT/royalti-video-engine/src/iyke-bridge.ts"
)

# HyperFrames preview projects each have their own src/. Find every
# index.html with a sibling src/main.* and copy alongside.
mapfile -t HF_DESTS < <(
  find "$ROOT/royalti-video-engine/hyperframes-projects" \
    -type f -name 'index.html' -path '*/preview/*' 2>/dev/null \
    | while read -r html; do
        dir="$(dirname "$html")"
        if [[ -f "$dir/main.tsx" || -f "$dir/main.ts" ]]; then
          echo "$dir/iyke-bridge.ts"
        fi
      done
) || true

DESTS+=("${HF_DESTS[@]}")

for d in "${DESTS[@]}"; do
  if [[ -z "$d" ]]; then continue; fi
  mkdir -p "$(dirname "$d")"
  cp "$SRC" "$d"
  echo "  → $d"
done

echo "synced ${#DESTS[@]} copies"

# Re-bundle the standalone IIFE used by the viewer-server's HTML injection.
# Without this, design previews opened via HtmlFrame would still see the
# previous bridge version.
PA_DESKTOP_ROOT="$(cd "$(dirname "$0")"/.. && pwd)"
if command -v bun >/dev/null 2>&1; then
  ( cd "$PA_DESKTOP_ROOT" && bun run iyke:bundle >/dev/null )
  echo "  → $PA_DESKTOP_ROOT/src-tauri/resources/iyke-iframe-bridge.js (re-bundled)"
else
  echo "warn: bun not found — skipping viewer-server bridge re-bundle" >&2
fi

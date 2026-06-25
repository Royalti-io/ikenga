#!/usr/bin/env bash
# Build the Playwright sidecar's dist/sidecar.js so the dev-fallback resolution
# in PlaywrightProxy (A1, WP-A1.1) finds it during `bun run tauri dev`.
#
# Unlike build-iyke-mcp.sh this does NOT copy into the shell's builtin-pkgs dir:
# the sidecar's dev-fallback entry IS the in-workspace pkg's own dist
# (../ikenga-pkgs/packages/sidecars/playwright-browser/dist/sidecar.js), and at
# runtime node resolves `playwright` from that pkg's node_modules. In a SHIPPED
# shell the sidecar is an installed registry pkg (resolved via pkg_installed),
# so this dev-only step is skipped gracefully when the sibling source is absent.
set -euo pipefail

cd "$(dirname "$0")/.."
SHELL_ROOT="$(pwd)"
SRC_DIR="${SHELL_ROOT}/../ikenga-pkgs/packages/sidecars/playwright-browser"

if [[ ! -d "${SRC_DIR}" ]]; then
  echo "==> playwright sidecar source not found at ${SRC_DIR} — skipping (dev-fallback only; an installed pkg ships its own dist)"
  exit 0
fi

# Deps live at the pnpm-workspace root, symlinked per-pkg. The bun build
# externalizes playwright (so build itself needs no deps), but the sidecar's
# RUNTIME spawn resolves playwright from this pkg's node_modules — ensure it.
if [[ ! -d "${SRC_DIR}/node_modules" ]]; then
  echo "==> installing ikenga-pkgs workspace deps (per-pkg node_modules missing for playwright-browser)"
  (cd "${SHELL_ROOT}/../ikenga-pkgs" && pnpm install --frozen-lockfile)
fi

echo "==> building playwright sidecar dist → ${SRC_DIR}/dist/sidecar.js"
(cd "${SRC_DIR}" && bun run build)

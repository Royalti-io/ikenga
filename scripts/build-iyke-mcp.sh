#!/usr/bin/env bash
# Bundle the iyke MCP server into a single JS file inside the built-in pkg
# dir. Runs as part of `bun run build` so the Tauri bundle always carries
# an up-to-date bundle.
#
# Output:
#   shell/src-tauri/resources/builtin-pkgs/com.ikenga.mcp-iyke/dist/index.js
#
# Why a JS bundle and not `bun --compile`:
#   The compiled-binary path embeds the full Bun runtime into every
#   sidecar (~80–97 MB each). Phase G of the registry migration drops
#   that pattern in favour of one bundled Bun shared across all sidecars
#   (see docs/adr/010-bundled-bun-runtime.md). The bundle here is
#   platform-agnostic JS — Bun (whether system or shell-bundled) runs it
#   the same way on every OS.
#
# At runtime the kernel spawns the manifest's mcp.command, which now reads
# `bun` with `args: ["run", "dist/index.js"]` and cwd = install_path.
# Bun resolves from cwd, so the relative path works.
#
# External MCP clients (Claude Desktop, Cursor) can still point at the
# bundle's absolute path with their own `bun` / Node — the bundle is
# pure JS, no runtime tie-in.

set -euo pipefail

cd "$(dirname "$0")/.."
SHELL_ROOT="$(pwd)"
PKG_DIR="${SHELL_ROOT}/src-tauri/resources/builtin-pkgs/com.ikenga.mcp-iyke"
SRC_DIR="${SHELL_ROOT}/../pkgs/mcp-iyke"

if [[ ! -d "${PKG_DIR}" ]]; then
  echo "error: builtin pkg dir missing: ${PKG_DIR}" >&2
  exit 1
fi

# Ensure deps are installed (uses the source pkg's bun.lock as canonical).
if [[ ! -d "${SRC_DIR}/node_modules" ]]; then
  echo "==> installing mcp-iyke deps in ${SRC_DIR}"
  (cd "${SRC_DIR}" && bun install --frozen-lockfile)
fi

mkdir -p "${PKG_DIR}/dist"
# Wipe any compiled-binary leftovers from the old --compile pipeline so
# upgraders don't end up with both a 97 MB binary AND a bundle sitting
# in the same dir.
rm -rf "${PKG_DIR}/bin"
OUTPUT="${PKG_DIR}/dist/index.js"

echo "==> bundling iyke-mcp → ${OUTPUT}"
# Bundle from the SOURCE pkg (which carries node_modules); output into
# the builtin-pkgs copy. Same boundary as before — the shipped pkg never
# carries node_modules.
#
# --target=bun keeps Bun-specific APIs available; the output spawn is
# always Bun, so we don't need to portable down to plain Node.
# --minify shrinks the bundle to ~hundreds of KB.
# --sourcemap=none keeps the shipped artifact lean; debug via the
# source pkg if needed.
(cd "${SRC_DIR}" && bun build \
  --target=bun \
  --minify \
  --sourcemap=none \
  src/index.ts \
  --outfile "${OUTPUT}")

echo "==> done: $(du -h "${OUTPUT}" | cut -f1) ${OUTPUT}"

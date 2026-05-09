#!/usr/bin/env bash
# Compile the bundled iyke MCP server into a single binary inside the
# built-in pkg dir. Runs as part of `bun run build` so the Tauri bundle
# always carries an up-to-date binary.
#
# Output (per platform):
#   Linux/macOS: shell/src-tauri/resources/builtin-pkgs/com.ikenga.mcp-iyke/bin/iyke-mcp
#   Windows:     shell/src-tauri/resources/builtin-pkgs/com.ikenga.mcp-iyke/bin/iyke-mcp.exe
#
# Tauri's resource-dir packaging picks up the entire builtin-pkgs/ tree,
# so the binary ships verbatim. The kernel auto-installs the pkg on first
# boot; the manifest's `mcp.command = "./bin/iyke-mcp"` resolves against
# the install dir (== resource dir during install_builtins). On Windows
# Tokio Command's CreateProcess honours PATHEXT, so the `.exe` extension
# is found automatically without changing the manifest.
#
# Multi-target / CI: pass TARGET env var (e.g. aarch64-apple-darwin) to
# cross-compile. Without it, the host's rustc target is used.
#
# At runtime: external MCP clients (Claude Desktop, Cursor) configure their
# MCP server entry to point at the absolute path the settings panel
# surfaces. The shell's running iyke control bridge handles the actual
# RPC; this binary just forwards.

set -euo pipefail

cd "$(dirname "$0")/.."
SHELL_ROOT="$(pwd)"
PKG_DIR="${SHELL_ROOT}/src-tauri/resources/builtin-pkgs/com.ikenga.mcp-iyke"
SRC_DIR="${SHELL_ROOT}/../pkgs/mcp-iyke"

if [[ ! -d "${PKG_DIR}" ]]; then
  echo "error: builtin pkg dir missing: ${PKG_DIR}" >&2
  exit 1
fi

# Resolve target. Mirrors sidecars/*/build.sh — same triple shape so binary
# names match the rest of the pkg ecosystem.
TARGET="${TARGET:-$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')}"
if [[ -z "${TARGET:-}" ]]; then
  echo "error: could not infer target triple; pass it as TARGET env var" >&2
  exit 1
fi

case "$TARGET" in
  x86_64-unknown-linux-gnu)   BUN_TARGET="bun-linux-x64" ;;
  aarch64-unknown-linux-gnu)  BUN_TARGET="bun-linux-arm64" ;;
  x86_64-apple-darwin)        BUN_TARGET="bun-darwin-x64" ;;
  aarch64-apple-darwin)       BUN_TARGET="bun-darwin-arm64" ;;
  x86_64-pc-windows-msvc)     BUN_TARGET="bun-windows-x64" ;;
  *) echo "error: unsupported target triple: $TARGET" >&2; exit 1 ;;
esac

# Ensure deps are installed (uses the source pkg's bun.lock as canonical).
if [[ ! -d "${SRC_DIR}/node_modules" ]]; then
  echo "==> installing mcp-iyke deps in ${SRC_DIR}"
  (cd "${SRC_DIR}" && bun install --frozen-lockfile)
fi

mkdir -p "${PKG_DIR}/bin"
OUTPUT="${PKG_DIR}/bin/iyke-mcp"

echo "==> compiling iyke-mcp → ${OUTPUT} (bun target: ${BUN_TARGET})"
# Compile from the SOURCE pkg (it has node_modules); output into the
# builtin-pkgs copy. This keeps node_modules out of the shipped pkg.
# Output filename is target-agnostic so the manifest's
# `command: "./bin/iyke-mcp"` resolves cleanly without {target}
# expansion (which the mcp[] schema does not support — sidecars[] does).
# Multi-target builds: each invocation overwrites for the build host,
# which is the intended shape — one installer = one target.
(cd "${SRC_DIR}" && bun build --compile --target="${BUN_TARGET}" --minify \
  src/index.ts --outfile "${OUTPUT}")
chmod +x "${OUTPUT}"

echo "==> done: $(du -h "${OUTPUT}" | cut -f1) ${OUTPUT}"

/**
 * Set the base URL Remotion's `staticFile()` resolves against.
 *
 * Engine assets live under `ikenga-desktop/public/video/...` (mirroring
 * `royalti-video-engine/public/...` one level deeper to avoid colliding with
 * PA's own public/ chrome). Remotion reads `window.remotion_staticBase` when
 * resolving staticFile() calls — set it once before any composition mounts.
 *
 * The render path uses `Config.setPublicDir("./public/video")` in
 * remotion.config.ts; this file handles the equivalent for the in-webview
 * Player.
 */

// Remotion already declares `window.remotion_staticBase: string` globally
// (see node_modules/remotion/dist/cjs/index.d.ts). We just write to it.

let installed = false;

export function ensureStaticBaseInstalled(): void {
  if (installed) return;
  if (typeof window !== "undefined") {
    (window as unknown as { remotion_staticBase: string }).remotion_staticBase = "/video";
  }
  installed = true;
}

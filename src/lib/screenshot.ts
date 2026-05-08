// DOM-to-PNG capture helper. Pure FE — Wayland/GNOME has no usable
// compositor screencopy without a portal prompt and Tauri 2 doesn't
// expose `WebviewWindow::capture` on Linux, so we draw the live React
// tree ourselves via `modern-screenshot`. Works regardless of focus or
// minimized state because the DOM stays mounted in memory.
//
// The Rust side calls `screenshot://request` events with a request_id;
// we encode and post the bytes back through `screenshot_capture_done`.

import { domToBlob } from 'modern-screenshot';

export interface CaptureOutput {
  base64: string;
  width: number;
  height: number;
}

// Hard ceiling on how long a single FE capture may take. Picked below
// the Rust-side 60s timeout so we always return a meaningful error
// (rather than letting the Rust oneshot expire silently). Cross-origin
// iframes (storyboard :3105, hyperframes, video-engine) are the usual
// reason capture hangs — modern-screenshot tries to inline them and
// blocks on a fetch the browser will never resolve.
const FE_CAPTURE_TIMEOUT_MS = 30_000;

/**
 * Render the given element (or `document.documentElement` for the whole
 * window) to a PNG, return base64 + dimensions. Throws on failure — the
 * caller decides what to do.
 */
export async function captureToPng(target: HTMLElement): Promise<CaptureOutput> {
  // `scale: window.devicePixelRatio` keeps Retina/HiDPI sharp without
  // reading the actual compositor; `backgroundColor: null` preserves
  // transparency edges from rounded panel borders.
  //
  // Iframes are walked into (since Phase 1 same-origin viewer-server) so
  // artifact pane content reaches the PNG. `data-screenshot="skip"` opts
  // a node out.
  //
  // `font: false` skips `embedWebFont` entirely. The shell's index.html
  // loads Google Fonts via `<link>`; the resulting cross-origin
  // CSSStyleSheet throws SecurityError on `cssRules` access (which
  // modern-screenshot catches but logs). Either way no fonts are
  // inlined — system fallbacks render fine, the SVG foreignObject uses
  // whatever the browser already has loaded. Skipping saves the
  // stylesheet walk + any same-origin @font-face URL fetches.
  //
  // `fetch.requestInit.cache: 'force-cache'` keeps any unforeseen image
  // fetches from re-hitting the network on every capture.
  //
  // `timeout: 3000` lowers modern-screenshot's per-request fetch
  // timeout (default 30s) so a hypothetical hung external fetch can't
  // eat the entire FE_CAPTURE_TIMEOUT_MS budget. With `font: false`
  // there should be no network at all on the steady-state path; this
  // is defence-in-depth for future iframe content that might inline
  // remote images.
  const blobPromise = domToBlob(target, {
    scale: window.devicePixelRatio || 1,
    type: 'image/png',
    backgroundColor: null,
    font: false,
    timeout: 3000,
    filter: (node) => {
      if (!(node instanceof Element)) return true;
      if (node.getAttribute('data-screenshot') === 'skip') return false;
      return true;
    },
    fetch: { requestInit: { cache: 'force-cache' } },
  });

  // Race the capture against a hard ceiling so cross-origin iframe hangs
  // surface as a clean FE error rather than a silent 60s Rust-side wait.
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `capture exceeded ${FE_CAPTURE_TIMEOUT_MS}ms (likely a cross-origin iframe or pending fetch)`,
        ),
      );
    }, FE_CAPTURE_TIMEOUT_MS);
  });

  let blob: Blob | null;
  try {
    blob = await Promise.race([blobPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
  if (!blob) throw new Error('capture produced empty blob');

  const buf = new Uint8Array(await blob.arrayBuffer());
  const base64 = uint8ToBase64(buf);
  const rect = target.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    base64,
    width: Math.max(1, Math.round(rect.width * dpr)),
    height: Math.max(1, Math.round(rect.height * dpr)),
  };
}

/** Capture the whole webview viewport. */
export function captureWindow(): Promise<CaptureOutput> {
  return captureToPng(document.documentElement);
}

/** Capture a single pane by `data-pane-id`. Throws if the pane isn't
 *  mounted — the caller should treat that as a 404. */
export function capturePane(paneId: string): Promise<CaptureOutput> {
  const el = document.querySelector<HTMLElement>(
    `[data-pane-id="${cssEscape(paneId)}"]`,
  );
  if (!el) throw new Error(`pane not found: ${paneId}`);
  return captureToPng(el);
}

// Tiny base64 encoder for binary buffers — `btoa` chokes on non-Latin1
// bytes, and PNG has plenty. Done in 32KB chunks so we don't blow the
// argument-list limit on `String.fromCharCode.apply`.
function uint8ToBase64(buf: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      buf.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(s);
}

// Quote-safe attribute selector. CSS.escape is widely available but not
// in jsdom; this fallback covers the characters our pane ids actually use.
function cssEscape(v: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(v);
  }
  return v.replace(/["\\]/g, '\\$&');
}

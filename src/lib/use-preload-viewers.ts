// Idle-time chunk warmup for the lazy artifact viewers.
//
// auto-router.tsx splits PdfView, XlsxView, and CodeView into their own
// chunks (saves ~760KB / ~240KB gz off cold start). The first time a
// user opens a PDF/XLSX/code file, those chunks have to fetch + parse —
// that's a visible Suspense flicker.
//
// This hook fires the dynamic imports during browser idle time after
// the workspace has settled. Vite's chunk cache holds them; later
// open-as-pane is a synchronous module hit. The actual import promise
// is discarded — we don't need the modules now, we just want them in
// memory.

import { useEffect } from 'react';

/** Wait for an idle window before kicking off preloads. The browser
 *  guarantees the timeout fallback fires within `maxDelayMs` even if
 *  the main thread never goes idle. */
function whenIdle(cb: () => void, maxDelayMs = 4000): () => void {
  type IdleHandle = number;
  type Win = Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => IdleHandle;
    cancelIdleCallback?: (h: IdleHandle) => void;
  };
  const w = window as Win;
  if (typeof w.requestIdleCallback === 'function') {
    const handle = w.requestIdleCallback(cb, { timeout: maxDelayMs });
    return () => w.cancelIdleCallback?.(handle);
  }
  // Safari / older webviews — plain timeout. 2s is long enough for first
  // paint + the user's first interaction; matches the comment in
  // workspace.tsx about hydration races.
  const t = setTimeout(cb, 2000);
  return () => clearTimeout(t);
}

export function usePreloadViewers() {
  useEffect(() => {
    const cancel = whenIdle(() => {
      // Fire-and-forget. Errors here are harmless — the lazy import
      // still works on actual demand. Logging would be noise.
      void import('@/viewer/renderers/code-view').catch(() => {});
      void import('@/viewer/renderers/pdf-view').catch(() => {});
      void import('@/viewer/renderers/xlsx-view').catch(() => {});
    });
    return cancel;
  }, []);
}

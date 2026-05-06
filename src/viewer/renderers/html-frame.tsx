import { useEffect, useRef, useState } from "react";
import { AlertCircle, ExternalLink, Loader2 } from "lucide-react";
import {
  fsListenWatch,
  fsRead,
  fsUnwatch,
  fsWatch,
  viewerServe,
  viewerStop,
  type ViewerHandle,
} from "@/lib/tauri-cmd";
import { registerIykeIframe } from "@/lib/iyke/iframe-registry";
import { pickViewerRoot } from "../lib/relative-root";

interface HtmlFrameProps {
  path: string;
  /** Pane ID for iyke iframe registration. Without it, the iyke CLI can't
   * target the previewed page (DOM, screenshot, console). The artifact pane
   * threads this through; standalone usages can omit it. */
  paneId?: string;
}

// Renders HTML artifacts in a sandboxed iframe served by the Rust axum server
// (`viewer_serve`). Each mount spawns a server scoped to the file's parent
// directory — relative assets (CSS, fonts, images) resolve naturally because
// the iframe origin matches the served root. The token in the URL gates
// access; see `src-tauri/src/viewer_server/mod.rs`.
//
// Sandbox flags:
// - `allow-scripts`: required for legitimate Claude-generated HTML that uses
//   inline scripts for interactivity.
// - `allow-same-origin`: required for relative `<link>` and `<script src>`
//   resolution under the token-scoped origin.
// External script loads are blocked by the CSP header injected on every
// response from the viewer server.
export function HtmlFrame({ path, paneId }: HtmlFrameProps) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; src: string; handle: ViewerHandle }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let handle: ViewerHandle | null = null;

    setState({ kind: "loading" });

    fsRead(path)
      .then((res) => {
        const html = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(res.bytes));
        const { root, file } = pickViewerRoot(path, html);
        return viewerServe(root).then((h) => ({ h, file }));
      })
      .then(({ h, file }) => {
        handle = h;
        if (cancelled) {
          // The mount was unmounted before the server finished spinning up —
          // tear it down to avoid leaking ports.
          void viewerStop(h.token);
          return;
        }
        setState({ kind: "ready", src: `${h.url}${file}`, handle: h });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
      if (handle) {
        void viewerStop(handle.token);
      }
    };
  }, [path]);

  // Hot-reload the iframe in place when the underlying file changes on disk.
  // Watches the parent directory (the viewer-server's root) so edits to
  // sibling assets (CSS/JS the page imports) also trigger a refresh, which
  // matches the user's mental model: "I edited the file, refresh the pane."
  // Debounced so a save that emits Create+Modify doesn't reload twice.
  useEffect(() => {
    let cancelled = false;
    let watcherId: string | null = null;
    let unlisten: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const slash = path.lastIndexOf("/");
        const parent = slash > 0 ? path.slice(0, slash) : path;
        const id = await fsWatch(parent);
        if (cancelled) {
          void fsUnwatch(id);
          return;
        }
        watcherId = id;
        unlisten = await fsListenWatch(id, () => {
          if (cancelled) return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const iframe = iframeRef.current;
            if (!iframe || !iframe.src) return;
            // Reassigning `src` re-fetches from the viewer-server, which has
            // no caching. The user sees only the iframe blink, not the app.
            iframe.src = iframe.src;
          }, 100);
        });
      } catch {
        // Watcher is best-effort — if it fails (path gone, perms), the user
        // can still manually re-open the artifact.
      }
    })();

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (unlisten) unlisten();
      if (watcherId) void fsUnwatch(watcherId);
    };
  }, [path]);

  // Register the iframe with iyke once the viewer-server is up and the
  // iframe element exists. The viewer-server injects the iframe-side bridge
  // into the served HTML, so iyke DOM/click/console/network calls flow
  // through `iyke://iframe-message` for `--pane=<paneId>`.
  const readySrc = state.kind === "ready" ? state.src : null;
  useEffect(() => {
    if (!paneId || !readySrc) return;
    const el = iframeRef.current;
    if (!el) return;
    return registerIykeIframe(paneId, el, "html-frame");
  }, [paneId, readySrc]);

  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Spinning up viewer…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex h-full items-start justify-center p-6 text-xs text-destructive">
        <AlertCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
        <span className="break-all">{state.message}</span>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
        <ExternalLink className="h-3 w-3" />
        <span className="truncate font-mono" title={state.src}>
          {state.src}
        </span>
      </div>
      <iframe
        ref={iframeRef}
        title={path}
        src={state.src}
        sandbox="allow-scripts allow-same-origin"
        className="h-full w-full flex-1 border-0 bg-background"
      />
    </div>
  );
}

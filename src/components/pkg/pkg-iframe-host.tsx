// Host-side wrapper for an iframe-mounted MCP App package.
//
// On mount: calls pkg_content_html() which reads the iframe entry HTML from
// the pkg's dist/, mints a per-iframe access token, and injects a
// `<base href>` pointing at `http://127.0.0.1:<port>/<pkgId>/<token>/`. The
// HTML is assigned to `<iframe srcdoc>` so the iframe document inherits the
// parent origin (works around https://github.com/tauri-apps/tauri/issues/12767
// — WebKitGTK refuses to render iframe documents loaded from non-https
// origins, including Tauri's own custom protocols, even though subresource
// fetches succeed). Subresource loads (`./app.js`, CSS, images) still go
// through the existing axum content server via the injected base href.
//
// Once the iframe loads, we construct an AppBridge with the iframe's
// contentWindow as the postMessage transport, install a tools/call handler
// that forwards to pkg_mcp_call, and send the initial McpUiHostContext
// (theme + CSS variables + royaltiAuth token).
//
// On theme change: pushes ui/notifications/host-context-changed so the
// iframe re-renders with the new mode/styles.
//
// On unmount: tears down the AppBridge and calls pkg_content_revoke to drop
// the token.
//
// Sandbox: `allow-scripts allow-same-origin`. With `srcdoc`, the iframe is
// already same-origin to the parent regardless of the sandbox attribute;
// `allow-same-origin` is kept for parity with the existing viewer pattern
// in src/viewer/renderers/html-frame.tsx and to keep AppBridge's same-origin
// optimizations available. CSP is enforced on the subresource-server
// response, not via the iframe sandbox attribute.
//
// Strict-mode safety per feedback_react_listener_strict_mode.md — bridge
// instance is keyed by ref and torn down + recreated cleanly on each effect
// run; no useRef-mount-guard + cancelled-flag combination.

import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { useEffect, useRef, useState } from 'react';

import { mintPkgToken } from '@/lib/pkg/auth-token';
import { buildHostContext } from '@/lib/pkg/host-context';
import { useIkengaStore } from '@/lib/ikenga/theme-store';
import {
  pkgContentHtml,
  pkgContentRevoke,
  pkgMcpCall,
} from '@/lib/tauri-cmd';

interface PkgIframeHostProps {
  pkgId: string;
  /** Manifest's `ui.routes[].source` (e.g. `dist/index.html`). The pkg-content
   *  URL is `<base>/<source>` where `<base>` already includes the trailing
   *  slash. */
  source: string;
  /** Optional callback invoked when `ui/initialize` round-trips, useful for
   *  smoke tests asserting the protocol path lit up. */
  onInitialized?: () => void;
}

const HOST_INFO = { name: 'ikenga-desktop', version: '0.1.0' };
const HOST_CAPABILITIES = {
  openLinks: {},
  serverTools: {},
  logging: {},
} as const;

export function PkgIframeHost({ pkgId, source, onInitialized }: PkgIframeHostProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenForRevoke, setTokenForRevoke] = useState<string | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  // We mint the auth token once per mount and reuse it across re-renders.
  const authTokenRef = useRef<string>('');

  // Subscribe to theme so we can push host-context-changed when it flips.
  const themeMode = useIkengaStore((s) => s.mode);

  // Stabilize onInitialized via ref so effect deps stay constant. Without
  // this, every parent re-render recreates the callback → effect re-runs →
  // bridge is torn down + reattached, and we miss the iframe's initialize.
  const onInitializedRef = useRef(onInitialized);
  useEffect(() => {
    onInitializedRef.current = onInitialized;
  }, [onInitialized]);

  // Step 1: read the iframe HTML + mint a subresource token (per-mount).
  useEffect(() => {
    let dropped = false;
    authTokenRef.current = mintPkgToken();
    // eslint-disable-next-line no-console
    console.log('[pkg-iframe-host] mount', pkgId, source);
    (async () => {
      try {
        const handle = await pkgContentHtml(pkgId, source);
        // eslint-disable-next-line no-console
        console.log('[pkg-iframe-host] got html', pkgId, handle.html.length, 'bytes');
        if (dropped) {
          // Effect re-ran before we got the HTML back; drop this one.
          await pkgContentRevoke(handle.token).catch(() => {});
          return;
        }
        setTokenForRevoke(handle.token);
        setSrcDoc(handle.html);
      } catch (e) {
        if (!dropped) setError((e as Error).message ?? String(e));
      }
    })();
    return () => {
      dropped = true;
      // Token revoke handled by the unmount-only effect below so the order is
      // bridge-teardown → revoke. If we revoked here, an in-flight bridge
      // request could 404 mid-teardown.
    };
  }, [pkgId, source]);

  // Step 2: connect AppBridge once the iframe is loaded.
  useEffect(() => {
    if (!srcDoc) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    let bridge: AppBridge | null = null;
    let teardown: (() => void) | null = null;

    const onLoad = () => {
      if (!iframe.contentWindow) return;
      const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
      bridge = new AppBridge(null, HOST_INFO, HOST_CAPABILITIES, {
        hostContext: buildHostContext({
          pkgId,
          authToken: authTokenRef.current,
        }),
      });
      bridge.oncalltool = (async (params) => {
        const result = await pkgMcpCall(pkgId, params.name, params.arguments ?? {});
        if (!result.ok) {
          // The MCP call failed at the host; surface as an MCP-level tool
          // error so the iframe can render appropriately.
          return {
            content: [
              {
                type: 'text' as const,
                text: result.error ?? 'unknown error',
              },
            ],
            isError: true,
          };
        }
        // Pass the sidecar's tool-call result through verbatim so callers
        // see both `content[]` and `structuredContent` (the wrapper UI
        // relies on the latter). Fall back to an empty content array if
        // a sidecar returns nothing — the AppBridge schema requires
        // `content` to be present.
        const tr = (result.result as Record<string, unknown> | null | undefined) ?? {};
        return {
          ...tr,
          content: Array.isArray((tr as { content?: unknown }).content)
            ? (tr as { content: unknown[] }).content
            : [],
        };
        // The CallToolResult union is more specific than what we can
        // statically prove from a runtime JSON value; trust the sidecar
        // here and cast at the boundary.
      }) as AppBridge['oncalltool'];
      bridge.addEventListener('initialized', () => {
        onInitializedRef.current?.();
      });
      bridgeRef.current = bridge;
      bridge.connect(transport).catch((e: unknown) => {
        setError(`bridge connect failed: ${(e as Error).message ?? String(e)}`);
      });
    };

    iframe.addEventListener('load', onLoad);
    teardown = () => {
      iframe.removeEventListener('load', onLoad);
      // Closing the bridge tears down the postMessage transport and
      // unhooks all listeners.
      try {
        bridge?.close();
      } catch {
        // best-effort
      }
      bridgeRef.current = null;
    };

    return () => {
      teardown?.();
    };
  }, [srcDoc, pkgId]);

  // Step 3: push host-context-changed when theme flips.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    try {
      bridge.sendHostContextChange({
        hostContext: buildHostContext({
          pkgId,
          authToken: authTokenRef.current,
        }),
      });
    } catch {
      // The bridge may not be initialized yet — the initial hostContext we
      // passed to the constructor will reflect the current theme anyway.
    }
  }, [themeMode, pkgId]);

  // Step 4: revoke the content token on full unmount.
  useEffect(() => {
    return () => {
      const t = tokenForRevoke;
      if (t) {
        pkgContentRevoke(t).catch(() => {});
      }
    };
  }, [tokenForRevoke]);

  if (error) {
    return (
      <div className="p-4 text-sm text-red-500">
        <div className="font-semibold">Failed to load package UI</div>
        <div className="text-xs opacity-80 mt-1">{error}</div>
      </div>
    );
  }

  if (!srcDoc) {
    return <div className="p-4 text-xs opacity-60">Loading package…</div>;
  }

  // eslint-disable-next-line no-console
  console.log('[pkg-iframe-host] rendering iframe', pkgId, 'srcDoc bytes:', srcDoc.length);

  return (
    <div data-iframe-host={pkgId} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        data-pkg-id={pkgId}
        className="w-full h-full border-0"
        style={{ flex: 1, minHeight: 0 }}
        sandbox="allow-scripts allow-same-origin"
        title={`Package ${pkgId}`}
      />
    </div>
  );
}

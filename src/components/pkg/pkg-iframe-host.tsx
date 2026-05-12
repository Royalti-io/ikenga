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
import { usePaneStore } from '@/lib/panes/pane-store';
import { pkgContentHtml, pkgContentRevoke, pkgMcpCall, pkgSidecarCall } from '@/lib/tauri-cmd';

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

// Result shape an MCP-style CallTool handler must return. AppBridge's
// `oncalltool` typing is wide; we narrow to what we actually emit so the
// host dispatcher branches stay readable.
interface HostCallResult {
	content: Array<{ type: 'text'; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

// Shell-side dispatcher for `host.*` tools. Runs before any pkg MCP
// lookup. Recognized names today:
//
// - `host.pkgSidecarCall({ sidecar, args, stdin?, timeoutSecs? })` —
//   invokes one of the calling pkg's declared sidecars via Tauri's
//   `pkg_sidecar_call`. The sidecar's stdout is parsed as JSON when
//   possible and returned as `structuredContent` so callers can pick up
//   structured results (success flags, durationMs, payload). Falls back
//   to wrapping raw stdout when the sidecar emits non-JSON.
// - `host.navigate({ path })` — navigates the focused pane to the given
//   route path. Mirrors the `hostNavigate` shape used by older pkgs.
//
// Anything else under `host.*` returns an MCP-protocol error (isError:
// true) so the iframe's error handling fires. We intentionally do NOT
// fall through to pkg_mcp_call for unknown host.* names — that would
// make typo'd tool names look like missing-MCP-server failures, which
// is harder to debug.
async function dispatchHostCall(
	pkgId: string,
	name: string,
	rawArgs: unknown
): Promise<HostCallResult> {
	const args = (rawArgs ?? {}) as Record<string, unknown>;

	if (name === 'host.pkgSidecarCall') {
		const sidecar = typeof args.sidecar === 'string' ? args.sidecar : null;
		if (!sidecar) {
			return errResult('host.pkgSidecarCall: missing required `sidecar` argument');
		}
		const callArgs = Array.isArray(args.args)
			? args.args.filter((a): a is string => typeof a === 'string')
			: [];
		const stdin = typeof args.stdin === 'string' ? args.stdin : undefined;
		const timeoutSecs = typeof args.timeoutSecs === 'number' ? args.timeoutSecs : undefined;

		const result = await pkgSidecarCall(pkgId, sidecar, callArgs, {
			stdin,
			timeoutSecs,
		});

		if (!result.ok) {
			return {
				content: [
					{
						type: 'text',
						text: result.error ?? `sidecar ${sidecar} failed`,
					},
				],
				isError: true,
				structuredContent: {
					ok: false,
					error: result.error ?? null,
					stdout: result.stdout ?? null,
					stderr: result.stderr ?? null,
					exit_code: result.exit_code,
					timed_out: result.timed_out,
				},
			};
		}

		// Sidecars that follow the `pa-actions` convention emit one structured
		// JSON object per run on stdout. Try to parse so callers get the
		// typed payload; if the sidecar emits raw text, surface that
		// verbatim so debugging is still possible.
		let structured: Record<string, unknown>;
		const rawStdout = result.stdout ?? '';
		const lastLine = rawStdout
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
			.pop();
		try {
			structured = lastLine
				? (JSON.parse(lastLine) as Record<string, unknown>)
				: { ok: true, stdout: rawStdout };
		} catch {
			structured = { ok: true, stdout: rawStdout, stderr: result.stderr ?? '' };
		}
		return {
			content: [{ type: 'text', text: rawStdout }],
			structuredContent: structured,
		};
	}

	if (name === 'host.navigate') {
		const path = typeof args.path === 'string' ? args.path : null;
		if (!path) {
			return errResult('host.navigate: missing required `path` argument');
		}
		try {
			usePaneStore.getState().navigateFocused(path);
		} catch (e) {
			return errResult(`host.navigate failed: ${(e as Error).message ?? String(e)}`);
		}
		return {
			content: [{ type: 'text', text: 'navigated' }],
			structuredContent: { ok: true, path },
		};
	}

	return errResult(`unknown host tool: ${name}`);
}

function errResult(message: string): HostCallResult {
	return {
		content: [{ type: 'text', text: message }],
		isError: true,
		structuredContent: { ok: false, error: message },
	};
}

export function PkgIframeHost({ pkgId, source, onInitialized }: PkgIframeHostProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [srcDoc, setSrcDoc] = useState<string | null>(null);
	const [baseUrl, setBaseUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tokenForRevoke, setTokenForRevoke] = useState<string | null>(null);
	const bridgeRef = useRef<AppBridge | null>(null);
	// We mint the auth token once per mount and reuse it across re-renders.
	const authTokenRef = useRef<string>('');
	// Resolved by the host when the pkg declared `capabilities.supabase`.
	// Stored in a ref so theme-flip rebuilds reuse the same value without
	// forcing the bridge to reconnect.
	const supabaseConfigRef = useRef<{ url: string; anonKey: string } | null>(null);

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
		(async () => {
			try {
				const handle = await pkgContentHtml(pkgId, source);
				if (dropped) {
					// Effect re-ran before we got the HTML back; drop this one.
					await pkgContentRevoke(handle.token).catch(() => {});
					return;
				}
				supabaseConfigRef.current = handle.supabase ?? null;
				setTokenForRevoke(handle.token);
				setBaseUrl(handle.baseUrl);
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
					supabase: supabaseConfigRef.current,
				}),
			});
			bridge.oncalltool = (async (params) => {
				// host.* tools are dispatched by the shell directly, *before*
				// any pkg-MCP-server lookup. This is the path pkg iframes use to
				// invoke their declared sidecars, navigate the focused pane, and
				// surface notifications back to the shell. Without this branch
				// every host.* call would fall through to pkg_mcp_call and fail
				// for pkgs that don't ship an MCP server (which is most of them).
				if (params.name.startsWith('host.')) {
					return await dispatchHostCall(pkgId, params.name, params.arguments ?? {});
				}
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

		// Race: WebKit fires `load` synchronously when srcDoc is assigned during
		// React's commit phase, BEFORE this post-commit effect runs. So we check
		// readyState first; if the doc is already complete we invoke onLoad
		// ourselves. Listener is still added for the (rare) async case.
		if (iframe.contentDocument?.readyState === 'complete') {
			onLoad();
		}
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
					supabase: supabaseConfigRef.current,
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

	if (!srcDoc || !baseUrl) {
		return <div className="p-4 text-xs opacity-60">Loading package…</div>;
	}

	// Use srcDoc (not src=) per Tauri #12767: WebKitGTK refuses to render
	// iframe DOC loads from any non-https origin (custom protocol or http
	// loopback). srcdoc inherits the parent origin so the doc loads. The
	// earlier concern about subresource fetches from about:srcdoc not firing
	// is mitigated by `absolutize_relative_urls` server-side: every script
	// and link in the html has a fully-qualified `http://127.0.0.1:<port>/...`
	// URL, so WebKit doesn't need to honour `<base href>` for srcdoc.
	return (
		<div
			data-iframe-host={pkgId}
			style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
		>
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

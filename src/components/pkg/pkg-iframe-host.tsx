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
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';

import { sendToActiveSession } from '@/components/pkg/send-to-active-session';
import { mintPkgToken } from '@/lib/pkg/auth-token';
import { buildHostContext } from '@/lib/pkg/host-context';
import { usePaneStore } from '@/lib/panes/pane-store';
import { usePkgMenuStore, type PkgMenuItem } from '@/lib/pkg/pkg-menu-store';
import {
	dbExec,
	dbQuery,
	pkgContentHtml,
	pkgContentRevoke,
	pkgKernelStatus,
	pkgMcpCall,
	pkgPreviewManifest,
	pkgSidecarCall,
	type SqlValue,
} from '@/lib/tauri-cmd';
import {
	openSessionDialog,
	type OpenSessionDialogOptions,
} from '@/components/pkg/open-session-dialog';

// Tauri event payload emitted by `Kernel::reload_pkg`. The FE only cares about
// `pkg_id` for the host filter; `version` + `registries` are useful for debug
// logging during dev loops.
interface PkgReloadedEvent {
	pkg_id: string;
	version: string;
	registries: string[];
}

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
// - `host.openSessionDialog({ initialPrompt?, title?, engineId?, sessionKind?,
//   cwd?, source? })` — opens the shell's New-Session dialog pre-filled with
//   the passed args; the user reads, edits, picks Chat vs Terminal, and
//   clicks Start (or Cancel). G-SESSION-DIALOG (Round 7, 2026-05-22) —
//   replaces the retired `host.startChatSession` verb + WP-10's separate
//   confirm modal. The dialog IS the consent surface. Gated on `engine:invoke`
//   (install-time sensitive per WP-13).
// - `host.sendToActiveSession({ prompt, source? })` — posts a user turn
//   into the focused chat pane's existing thread (WP-22 / G-ACTIVE-SESSION).
//   Gated on the same `engine:invoke` scope. **No per-call confirm modal**
//   — the user is already watching the thread the message lands in; the
//   source-stamp + strict refusal are the mitigations (locked 2026-05-21,
//   plans/groundwork/10-* §Prompt-injection notes). Refuses with
//   `reason: 'no-active-session'` when no chat pane is focused.
//
// Anything else under `host.*` returns an MCP-protocol error (isError:
// true) so the iframe's error handling fires. We intentionally do NOT
// fall through to pkg_mcp_call for unknown host.* names — that would
// make typo'd tool names look like missing-MCP-server failures, which
// is harder to debug.

// `host.*` verbs are dispatched FE-side before the kernel's IPC boundary, so
// the kernel's scope enforcement (RpcErrorCode.scope_denied) never runs for
// them. Verbs that touch a sensitive capability must therefore check the
// calling pkg's declared scope here. Manifest permissions are shaped as
// `{ <resource>: [<action>, …] }` (contract/src/manifest.ts), so `engine:invoke`
// is `permissions.engine` containing `'invoke'`. Fails closed on any error.
async function pkgDeclaresScope(pkgId: string, resource: string, action: string): Promise<boolean> {
	try {
		const status = await pkgKernelStatus();
		const entry = status.installed.find((p) => p.id === pkgId);
		if (!entry) return false;
		const manifest = await pkgPreviewManifest(entry.install_path);
		const actions = (manifest.permissions as Record<string, unknown> | undefined)?.[resource];
		return Array.isArray(actions) && actions.includes(action);
	} catch (e) {
		console.warn(`[pkg-host] scope check ${resource}:${action} for ${pkgId} failed:`, e);
		return false;
	}
}

// Whether the pkg declared `capabilities.sqlite` (opt-in to reading the local
// `pa.db`). Gates `host.dbQuery`. Same manifest-lookup shape as
// `pkgDeclaresScope`; fails closed on any error.
async function pkgDeclaresSqlite(pkgId: string): Promise<boolean> {
	try {
		const status = await pkgKernelStatus();
		const entry = status.installed.find((p) => p.id === pkgId);
		if (!entry) return false;
		const manifest = await pkgPreviewManifest(entry.install_path);
		const caps = manifest.capabilities as Record<string, unknown> | undefined;
		return !!caps?.sqlite;
	} catch (e) {
		console.warn(`[pkg-host] sqlite capability check for ${pkgId} failed:`, e);
		return false;
	}
}

// The tables a pkg declared it may touch via `permissions['sqlite.tables']`.
// Used to scope `host.dbExec` writes to the pkg's own tables. Same
// manifest-lookup shape as `pkgDeclaresSqlite`; fails closed (empty list) on
// any error so an unreadable manifest can write nothing.
async function pkgSqliteTables(pkgId: string): Promise<string[]> {
	try {
		const status = await pkgKernelStatus();
		const entry = status.installed.find((p) => p.id === pkgId);
		if (!entry) return [];
		const manifest = await pkgPreviewManifest(entry.install_path);
		const perms = manifest.permissions as Record<string, unknown> | undefined;
		const tables = perms?.['sqlite.tables'];
		return Array.isArray(tables) ? tables.filter((t): t is string => typeof t === 'string') : [];
	} catch (e) {
		console.warn(`[pkg-host] sqlite.tables lookup for ${pkgId} failed:`, e);
		return [];
	}
}

// Best-effort target-table extraction from a single write statement, for the
// `host.dbExec` table-scope guard. Matches the leading `INSERT INTO <t>` /
// `UPDATE <t>` / `DELETE FROM <t>`, stripping optional quoting. This is
// defense-in-depth over a single-user local pa.db (the SQL is
// pkg-author-controlled, not attacker-supplied) — not a hard security
// boundary. Returns null when no table can be identified, which the caller
// treats as a rejection.
function writeTargetTable(sql: string): string | null {
	const m =
		/^\s*insert\s+(?:or\s+\w+\s+)?into\s+["'`\[]?(\w+)/i.exec(sql) ??
		/^\s*update\s+["'`\[]?(\w+)/i.exec(sql) ??
		/^\s*delete\s+from\s+["'`\[]?(\w+)/i.exec(sql);
	return m ? m[1] : null;
}

// Exported for unit tests (the verb's scope-gate + confirm + decline
// branches). Not part of the pkg-facing API — callers go through the
// AppBridge `oncalltool` path below.
export async function dispatchHostCall(
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

	if (name === 'host.dbQuery') {
		// Read-path bridge (WP-04): lets an iframe pkg read the local `pa.db`
		// via the host's `db_query` Tauri command instead of an in-iframe
		// supabase-js client. Gated on the pkg declaring `capabilities.sqlite`
		// (opt-in to local SQLite) — `host.*` verbs bypass the kernel's scope
		// enforcement, so the check happens here, fails closed.
		// `db_query` is SELECT-only on the Rust side; we additionally reject
		// non-SELECT/WITH text as defense-in-depth. (Table-level scoping to the
		// pkg's declared `permissions['sqlite.tables']` is a follow-up — the
		// risk here is read-only access to the user's own single-user pa.db.)
		const sql = typeof args.sql === 'string' ? args.sql : null;
		if (!sql) {
			return errResult('host.dbQuery: missing required `sql` argument');
		}
		if (!/^\s*(select|with)\b/i.test(sql)) {
			return errResult('host.dbQuery: only SELECT/WITH read queries are allowed');
		}
		if (!(await pkgDeclaresSqlite(pkgId))) {
			return errResult("host.dbQuery: pkg lacks the 'sqlite' capability");
		}
		const params = Array.isArray(args.params) ? (args.params as SqlValue[]) : [];
		try {
			const rows = await dbQuery(sql, params);
			return {
				content: [{ type: 'text', text: `${rows.length} row(s)` }],
				structuredContent: { ok: true, rows },
			};
		} catch (e) {
			return errResult(`host.dbQuery failed: ${(e as Error).message ?? String(e)}`);
		}
	}

	if (name === 'host.dbExec') {
		// Write-path bridge (local-store write-path WP): lets an iframe pkg write
		// to the local `pa.db` via the host's `db_exec` Tauri command, so the last
		// supabase-js dependency (the tasks status-update write) can be removed.
		// `host.*` verbs bypass the kernel's scope enforcement, so every guard
		// happens here and fails closed:
		//   1. statement allowlist — only INSERT/UPDATE/DELETE; SELECT/WITH belong
		//      on `host.dbQuery`, and DDL/ATTACH/PRAGMA/VACUUM are rejected.
		//   2. `capabilities.sqlite` opt-in (same gate as `host.dbQuery`).
		//   3. table-scope — the statement's target table must be in the pkg's
		//      declared `permissions['sqlite.tables']`. Defense-in-depth over a
		//      single-user local pa.db (see `writeTargetTable`), not a hard boundary.
		const sql = typeof args.sql === 'string' ? args.sql : null;
		if (!sql) {
			return errResult('host.dbExec: missing required `sql` argument');
		}
		if (!/^\s*(insert|update|delete)\b/i.test(sql)) {
			return errResult('host.dbExec: only INSERT/UPDATE/DELETE write statements are allowed');
		}
		if (!(await pkgDeclaresSqlite(pkgId))) {
			return errResult("host.dbExec: pkg lacks the 'sqlite' capability");
		}
		const target = writeTargetTable(sql);
		if (!target) {
			return errResult('host.dbExec: could not identify the target table');
		}
		const allowed = await pkgSqliteTables(pkgId);
		if (!allowed.includes(target)) {
			return errResult(`host.dbExec: table '${target}' not in the pkg's declared sqlite.tables`);
		}
		const params = Array.isArray(args.params) ? (args.params as SqlValue[]) : [];
		try {
			await dbExec(sql, params);
			return {
				content: [{ type: 'text', text: 'ok' }],
				structuredContent: { ok: true },
			};
		} catch (e) {
			return errResult(`host.dbExec failed: ${(e as Error).message ?? String(e)}`);
		}
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

	// host.pkg.setMenu({ items: [{id, label, icon?, badge?}] }) — pkg publishes
	// its current sidebar items to the shell. Shell renders them in the App-mode
	// sidebar when the focused pane is this pkg's route. Item clicks update the
	// active feature, which is re-emitted to the iframe via hostContext so the
	// pkg can swap its internal view.
	if (name === 'host.pkg.setMenu') {
		const rawItems = Array.isArray(args.items) ? args.items : [];
		const items: PkgMenuItem[] = [];
		for (const it of rawItems) {
			if (!it || typeof it !== 'object') continue;
			const obj = it as Record<string, unknown>;
			if (typeof obj.id !== 'string' || typeof obj.label !== 'string') continue;
			items.push({
				id: obj.id,
				label: obj.label,
				icon: typeof obj.icon === 'string' ? obj.icon : null,
				badge: typeof obj.badge === 'string' || typeof obj.badge === 'number' ? obj.badge : null,
				section: typeof obj.section === 'string' ? obj.section : null,
				disabled: obj.disabled === true,
				active: typeof obj.active === 'boolean' ? obj.active : undefined,
			});
		}
		usePkgMenuStore.getState().setMenu(pkgId, items);
		// If the pkg hasn't been told an active feature yet, seed it to the
		// first item so the pkg has a sensible default to render before any
		// click happens. The pkg can override this at any time by sending its
		// own preferred default in the menu order.
		const current = usePkgMenuStore.getState().activeFeatures[pkgId];
		if (!current && items[0]) {
			usePkgMenuStore.getState().setActiveFeature(pkgId, items[0].id);
		}
		return {
			content: [{ type: 'text', text: `menu set: ${items.length} items` }],
			structuredContent: { ok: true, count: items.length },
		};
	}

	// host.openSessionDialog({ initialPrompt?, title?, engineId?, sessionKind?,
	// cwd?, source? }) — open the shell's New-Session dialog pre-filled with
	// the passed args; the user reads, edits, picks Chat vs Terminal, and
	// clicks Start (or Cancel). G-SESSION-DIALOG (Round 7, 2026-05-22). The
	// dialog IS the consent surface — no separate confirm modal. Gated on
	// `engine:invoke` (install-time sensitive per WP-13) so pkgs declaring
	// the scope cleared a trust prompt at install.
	if (name === 'host.openSessionDialog') {
		// Scope gate — same shape as host.startChatSession; the dialog is the
		// per-call consent on top of the install-time trust check. Returns the
		// frozen `{ ok: false, reason: 'scope-denied' }` envelope as
		// structuredContent so callers can branch on it cleanly.
		if (!(await pkgDeclaresScope(pkgId, 'engine', 'invoke'))) {
			return {
				content: [{ type: 'text', text: "host.openSessionDialog: pkg lacks 'engine:invoke'" }],
				isError: true,
				structuredContent: { ok: false, reason: 'scope-denied' },
			};
		}

		const opts = coerceOpenSessionDialogArgs(args);
		const result = await openSessionDialog(opts);

		// Frozen signature: result is already in the shape callers expect
		// (chat | terminal | cancelled | scope-denied). Pass through verbatim
		// as structuredContent; mirror a human-readable summary into content
		// so the MCP wire's text channel has something useful.
		const summary = summarizeResult(result);
		return {
			content: [{ type: 'text', text: summary }],
			structuredContent: result as unknown as Record<string, unknown>,
		};
	}

	// host.sendToActiveSession({ prompt, source? }) — post a user turn into
	// the focused chat pane's existing thread (WP-22 / G-ACTIVE-SESSION).
	// Reuses the `engine:invoke` scope (install-time sensitive per WP-13).
	// **No per-call confirm modal** (locked 2026-05-21, see
	// plans/groundwork/10-* §Prompt-injection notes): the user is already
	// watching the thread the message lands in, the source-stamp creates
	// the audit trail, and refusal-on-no-active-session is the safety floor.
	// The signature is frozen by G-ACTIVE-SESSION — WP-21's palette codes
	// against `{ ok, threadId?, reason? }` and depends on its stability.
	if (name === 'host.sendToActiveSession') {
		const prompt = typeof args.prompt === 'string' ? args.prompt : null;
		if (!prompt) {
			return errResult('host.sendToActiveSession: missing required `prompt` argument');
		}
		const source = typeof args.source === 'string' ? args.source : undefined;

		// Scope gate (mirrors host.startChatSession). The kernel doesn't
		// enforce scopes on host.* verbs FE-side. Surface as `scope-denied`
		// in the structured payload so palette callers can branch cleanly
		// instead of treating it as a generic error.
		if (!(await pkgDeclaresScope(pkgId, 'engine', 'invoke'))) {
			return {
				content: [{ type: 'text', text: "lacks the 'engine:invoke' scope" }],
				isError: true,
				structuredContent: { ok: false, reason: 'scope-denied' },
			};
		}

		const res = await sendToActiveSession({ prompt, source });
		if (!res.ok) {
			// reason: 'no-active-session' | 'scope-denied' (the latter is
			// already handled above; keep the branch defensive in case the
			// core grows new refusal codes).
			return {
				content: [{ type: 'text', text: `refused: ${res.reason}` }],
				isError: true,
				structuredContent: { ok: false, reason: res.reason },
			};
		}
		return {
			content: [{ type: 'text', text: `sent to ${res.threadId}` }],
			structuredContent: { ok: true, threadId: res.threadId },
		};
	}

	return errResult(`unknown host tool: ${name}`);
}

/**
 * Defensive arg coercion for `host.openSessionDialog`. The verb's signature
 * is frozen (G-SESSION-DIALOG); junk values for typed fields fall through to
 * undefined rather than crashing the dialog. The dialog then applies its own
 * defaults (chat mode, default engine, active project root).
 */
function coerceOpenSessionDialogArgs(args: Record<string, unknown>): OpenSessionDialogOptions {
	const initialPrompt = typeof args.initialPrompt === 'string' ? args.initialPrompt : undefined;
	const title = typeof args.title === 'string' ? args.title : undefined;
	const engineId = typeof args.engineId === 'string' ? args.engineId : undefined;
	const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
	const sessionKind =
		args.sessionKind === 'chat' || args.sessionKind === 'terminal' ? args.sessionKind : undefined;
	const source = typeof args.source === 'string' ? args.source : undefined;
	return { initialPrompt, title, engineId, sessionKind, cwd, source };
}

function summarizeResult(result: Awaited<ReturnType<typeof openSessionDialog>>): string {
	if (result.ok && result.kind === 'chat') return `chat session started: ${result.threadId}`;
	if (result.ok && result.kind === 'terminal') return `terminal opened: ${result.paneId}`;
	if (!result.ok && result.reason === 'cancelled') return 'cancelled by user';
	if (!result.ok && result.reason === 'scope-denied') return 'scope denied';
	return 'unknown result';
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
	// Dev-mode: `Kernel::reload_pkg` emits a `pkg-reloaded` Tauri event after
	// the kernel finishes re-registering. Bumping this counter re-runs the
	// fetch effect below, which mints a fresh token + new srcDoc; that in turn
	// re-runs the bridge effect because srcDoc is in its dep array. Net effect:
	// the iframe remounts cleanly without us tearing down the React tree.
	const [reloadKey, setReloadKey] = useState(0);
	const bridgeRef = useRef<AppBridge | null>(null);
	// We mint the auth token once per mount and reuse it across re-renders.
	const authTokenRef = useRef<string>('');
	// Resolved by the host when the pkg declared `capabilities.supabase`.
	// Stored in a ref so theme-flip rebuilds reuse the same value without
	// forcing the bridge to reconnect.
	const supabaseConfigRef = useRef<{ url: string; anonKey: string } | null>(null);

	// Appearance reactivity (theme / mode / tint / workspace) is handled by a
	// MutationObserver on the <html> data-* attributes in Step 3 below, NOT by
	// subscribing to store fields. Reason: `mode:'system'` resolves to light|
	// dark on OS `prefers-color-scheme` flips WITHOUT any store value changing —
	// only the resolved `<html data-mode>` attribute flips. Observing the DOM
	// (the same :root `cssVariablesSnapshot()` reads) catches every case.

	// Active suite-feature for this pkg — driven by the shell sidebar via
	// `usePkgMenuStore.setActiveFeature`. We push it into hostContext so the
	// iframe can swap its mounted view in response.
	const activeFeature = usePkgMenuStore((s) => s.activeFeatures[pkgId]);

	// Stabilize onInitialized via ref so effect deps stay constant. Without
	// this, every parent re-render recreates the callback → effect re-runs →
	// bridge is torn down + reattached, and we miss the iframe's initialize.
	const onInitializedRef = useRef(onInitialized);
	useEffect(() => {
		onInitializedRef.current = onInitialized;
	}, [onInitialized]);

	// Step 1: read the iframe HTML + mint a subresource token (per-mount).
	// `reloadKey` is included so the dev-mode `pkg-reloaded` event re-runs
	// this effect — the manifest may have changed `ui.routes[].source` or
	// any other surface that affects the pkg-content output.
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
	}, [pkgId, source, reloadKey]);

	// Step 1b (dev-mode): listen for `Kernel::reload_pkg` events and bump the
	// reload counter when our pkg id matches. Only one listener per host
	// instance — the event channel is global, the filter happens in JS.
	useEffect(() => {
		let unlisten: UnlistenFn | null = null;
		let cancelled = false;
		listen<PkgReloadedEvent>('pkg-reloaded', (ev) => {
			if (cancelled) return;
			if (ev.payload?.pkg_id !== pkgId) return;
			setReloadKey((k) => k + 1);
		}).then((fn) => {
			if (cancelled) {
				fn();
				return;
			}
			unlisten = fn;
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [pkgId]);

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
					suite: { activeFeature: usePkgMenuStore.getState().activeFeatures[pkgId] },
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

	// Step 3: push host-context-changed when the resolved appearance flips
	// (theme / mode / tint / workspace) or the active suite-feature changes.
	// The pkg's onhostcontextchanged handler re-applies the `--color-*` palette
	// and reads `royaltiSuite.activeFeature` to swap its internal view.
	useEffect(() => {
		const repush = () => {
			const bridge = bridgeRef.current;
			if (!bridge) return;
			try {
				// `ui/notifications/host-context-changed` params ARE the host context
				// (McpUiHostContext) — NOT wrapped in `{ hostContext }`. The wrapped
				// shape silently type-checks (passthrough) but lands the app's
				// `onhostcontextchanged(ctx)` with `ctx = { hostContext: {...} }`, so
				// `ctx.royaltiSuite.activeFeature` reads undefined and the pkg never
				// swaps its view on a live sidebar click (it only updated on remount,
				// where `getHostContext()` returns the un-nested constructor value).
				// Pass the context directly so init and change agree on shape.
				bridge.sendHostContextChange(
					buildHostContext({
						pkgId,
						authToken: authTokenRef.current,
						supabase: supabaseConfigRef.current,
						suite: { activeFeature },
					})
				);
			} catch {
				// The bridge may not be initialized yet — the initial hostContext we
				// passed to the constructor will reflect the current state anyway.
			}
		};

		// Push immediately for the current activeFeature value.
		repush();

		// …then re-push on any appearance change. `installIkengaDomSync` writes
		// the resolved theme/mode/tint/workspace to these <html> attributes —
		// including OS `prefers-color-scheme` flips under `mode:'system'`, which
		// change no store value. Observing the DOM is the authoritative trigger
		// and stays in sync with `cssVariablesSnapshot()`, which reads this :root.
		const observer = new MutationObserver(repush);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-mode', 'data-theme', 'data-tint-strength', 'data-workspace'],
		});
		return () => observer.disconnect();
	}, [pkgId, activeFeature]);

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

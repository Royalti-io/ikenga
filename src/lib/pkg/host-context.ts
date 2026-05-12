// Build the McpUiHostContext payload sent to an iframe-mounted pkg's
// `App.initialize()`. Extends the spec shape (`[key: string]: unknown` per
// the schema) with a `royaltiAuth` block that carries the per-iframe token
// and pkgId — used by sidecar-aware MCP Apps to authenticate back to their
// own sidecar. v1: token is minted but not validated.
//
// We don't subscribe to the theme store here — `<PkgIframeHost>` owns the
// subscription and republishes via `host-context-changed` notifications on
// changes; this builder is the one-shot snapshot for the initialize handshake.

import type { McpUiHostContext, McpUiStyles } from '@modelcontextprotocol/ext-apps/app-bridge';

import { useIkengaStore } from '@/lib/ikenga/theme-store';
import { supabase } from '@/lib/supabase';

export interface RoyaltiAuth {
	token: string;
	pkg_id: string;
	/** Current user's Supabase access token. Pkgs use this to authenticate
	 *  their own vendored Supabase client against the same project the shell
	 *  reads from. `null` when the user is signed out — pkgs run anon-only. */
	supabaseJwt: string | null;
}

export interface HostSupabaseConfig {
	url: string;
	anonKey: string;
}

export function buildHostContext(opts: {
	pkgId: string;
	authToken: string;
	/** Resolved by `pkg_content_html` when the pkg declared
	 *  `capabilities.supabase`. Threaded through to the iframe so it can
	 *  configure its vendored Supabase client without baking secrets into its
	 *  build. Absent for pkgs that don't declare the capability. */
	supabase?: HostSupabaseConfig | null;
}): McpUiHostContext {
	const state = useIkengaStore.getState();
	const ctx: McpUiHostContext = {
		theme: state.mode === 'light' ? 'light' : 'dark',
		styles: {
			// Spec types `McpUiStyles` as a Record with every key required, but the
			// schema docs explicitly say hosts may provide any subset. We send only
			// the variables we know about, cast to satisfy the strict type.
			variables: cssVariablesSnapshot() as McpUiStyles,
		},
		royaltiAuth: {
			token: opts.authToken,
			pkg_id: opts.pkgId,
			supabaseJwt: currentSupabaseJwt(),
		} satisfies RoyaltiAuth,
	};
	if (opts.supabase) {
		(ctx as McpUiHostContext & { supabase: HostSupabaseConfig }).supabase = opts.supabase;
	}
	return ctx;
}

/** Read the current Supabase access token without forcing a refresh. The
 *  client persists it in localStorage and exposes it via `getSession()`;
 *  this returns `null` when no session is present (signed out). */
function currentSupabaseJwt(): string | null {
	// supabase-js v2 caches the session on the client object; reading it from
	// the public API is async (`getSession`), but the synchronous handshake
	// here can't await. The client also exposes the token synchronously via
	// its internal `auth` storage — we tap that to avoid round-tripping.
	// If supabase-js changes shape, we silently fall back to `null` and the
	// pkg's queries will run anon-only until the next host-context-changed.
	const auth = (supabase as unknown as { auth?: { currentSession?: { access_token?: string } } })
		.auth;
	return auth?.currentSession?.access_token ?? null;
}

// Read the resolved values of CSS custom properties from the host's `:root`.
// Only ship variable names allowed by the MCP UI Apps schema — the SDK
// validates `hostContext.styles.variables` against a strict literal-union of
// names matching the design-token convention `--color-{kind}-{slot}` plus a
// couple of font / radius / shadow tokens. Sending anything else fails the
// initialize handshake with `unrecognized_keys`. See app-bridge's
// `McpUiStyles` schema in @modelcontextprotocol/ext-apps for the full list.
function cssVariablesSnapshot(): Record<string, string> {
	if (typeof document === 'undefined') return {};
	const cs = getComputedStyle(document.documentElement);
	const slots = [
		'primary',
		'secondary',
		'tertiary',
		'inverse',
		'ghost',
		'info',
		'danger',
		'success',
		'warning',
		'disabled',
	];
	const keys: string[] = [];
	for (const kind of ['background', 'text', 'border']) {
		for (const slot of slots) keys.push(`--color-${kind}-${slot}`);
	}
	for (const slot of ['primary', 'secondary', 'inverse', 'info', 'danger', 'success', 'warning']) {
		keys.push(`--color-ring-${slot}`);
	}
	keys.push('--font-sans', '--font-mono');
	const out: Record<string, string> = {};
	for (const k of keys) {
		const v = cs.getPropertyValue(k).trim();
		if (v) out[k] = v;
	}
	return out;
}

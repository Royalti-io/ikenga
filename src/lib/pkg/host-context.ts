// Build the McpUiHostContext payload sent to an iframe-mounted pkg's
// `App.initialize()`. Extends the spec shape (`[key: string]: unknown` per
// the schema) with a `royaltiAuth` block that carries the per-iframe token
// and pkgId — used by sidecar-aware MCP Apps to authenticate back to their
// own sidecar. v1: token is minted but not validated.
//
// We don't subscribe to the theme store here — `<PkgIframeHost>` owns the
// subscription and republishes via `host-context-changed` notifications on
// changes; this builder is the one-shot snapshot for the initialize handshake.

import type {
  McpUiHostContext,
  McpUiStyles,
} from '@modelcontextprotocol/ext-apps/app-bridge';

import { useIkengaStore } from '@/lib/ikenga/theme-store';

export interface RoyaltiAuth {
  token: string;
  pkg_id: string;
}

export function buildHostContext(opts: {
  pkgId: string;
  authToken: string;
}): McpUiHostContext {
  const state = useIkengaStore.getState();
  return {
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
    } satisfies RoyaltiAuth,
  };
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

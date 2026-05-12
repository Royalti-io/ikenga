// Phase 5 — Connector registry.
//
// Connectors (Supabase, Resend, Listmonk, Twenty CRM, Stripe, …) are NOT
// a fixed first-run checklist. They surface dynamically when a pkg whose
// manifest declares them is selected (during onboarding) or installed
// (post-onboarding). Adding a new connector is one entry in this file
// plus its `write` / `status` adapters.
//
// Manifests already declare what they need:
//
//   - `capabilities.supabase.required: bool` — pkg needs URL + anon key
//     from the host vault.
//   - `permissions.vault.keys: string[]` — declared vault keys the pkg
//     expects (e.g. `RESEND_API_KEY`, `LISTMONK_URL`).
//
// Source of truth for the manifest shape:
//   • Rust: `ikenga/shell/src-tauri/src/pkg/manifest.rs`
//   • Zod : `ikenga/contract/src/manifest.ts` (`@ikenga/contract`)
//
// The `capabilities.supabase` block lives in the Rust schema but isn't
// yet mirrored into the Zod schema (out of Phase 5 scope), so the
// connector registry reads from the looser `ManifestLike` shape below
// instead of the strict Zod inferred type.

import {
	type SupabaseConfig,
	secretsDelete,
	secretsListKeys,
	secretsSet,
	secretsVaultStatus,
	supabaseConfigClear,
	supabaseConfigGet,
	supabaseConfigSet,
} from '@/lib/tauri-cmd';

// ---- Manifest shape we walk (subset of the Rust manifest) ---------------

/**
 * Lightweight manifest projection for the resolver. The shell-side `PkgManifestPreview`
 * shape (see `tauri-cmd.ts`) is structurally compatible — `capabilities` and
 * `permissions` are passed through verbatim from the parsed manifest.json.
 *
 * Keep this in sync with `CapabilitiesBlock` + `Permissions` in
 * `src-tauri/src/pkg/manifest.rs`.
 */
export interface ManifestLike {
	id: string;
	name?: string;
	version?: string;
	capabilities?: {
		supabase?: {
			required?: boolean;
		} | null;
	} | null;
	permissions?: {
		'vault.keys'?: string[];
		'supabase.tables'?: string[];
		[k: string]: unknown;
	} | null;
	[key: string]: unknown;
}

// ---- Connector contract -------------------------------------------------

export type ConnectorId = 'supabase' | 'resend' | 'listmonk' | 'twenty' | 'stripe';

export type ConnectorStatus = 'not_configured' | 'partial' | 'configured' | 'invalid';

export interface ConnectorField {
	id: string;
	label: string;
	type: 'text' | 'password' | 'url';
	required: boolean;
	/** When true, the value is sealed into Stronghold rather than a config
	 *  file. `vaultKey` becomes mandatory. */
	secret: boolean;
	/** Vault key name for `secret: true` fields. */
	vaultKey?: string;
	placeholder?: string;
	hint?: string;
}

export interface ConnectorTriggers {
	/** When set, the connector surfaces if `manifest.capabilities[capability].required` is true. */
	capability?: 'supabase';
	/** When set, the connector surfaces if `manifest.permissions['vault.keys']`
	 *  is a superset of these. */
	vaultKeys?: string[];
	/** Escape-hatch predicate for complex triggers. */
	predicate?: (manifest: ManifestLike) => boolean;
}

export interface ConnectorDef {
	id: ConnectorId;
	display: string;
	/** One-line description shown above the form. */
	tagline: string;
	triggers: ConnectorTriggers;
	fields: ConnectorField[];
	/** Persist collected values. Routes secret fields through Stronghold and
	 *  non-secret fields through whatever config surface the connector owns
	 *  (Supabase has its own JSON manifest; the rest are pure-vault). */
	write: (values: Record<string, string>) => Promise<void>;
	/** Read current configured state for the status badge. */
	status: () => Promise<ConnectorStatus>;
	/** Clear all persisted state for this connector (used by Settings → Reset). */
	clear?: () => Promise<void>;
	/** Optional liveness check — ping the configured endpoint. */
	test?: (values: Record<string, string>) => Promise<ConnectorTestResult>;
}

export interface ConnectorTestResult {
	ok: boolean;
	message?: string;
}

// ---- v1 registry --------------------------------------------------------

/**
 * The five v1 connectors. Adding a new one is one entry here; no other
 * code in the wizard or settings cards needs to change.
 */
export const CONNECTOR_REGISTRY: readonly ConnectorDef[] = Object.freeze([
	// ─── Supabase ────────────────────────────────────────────────────────
	{
		id: 'supabase',
		display: 'Supabase',
		tagline:
			'The shell threads URL + anon key into pkgs that declare capabilities.supabase. No build-time env vars.',
		triggers: { capability: 'supabase' },
		fields: [
			{
				id: 'url',
				label: 'Project URL',
				type: 'url',
				required: true,
				secret: false,
				placeholder: 'https://your-project.supabase.co',
				hint: 'From Project Settings → API → Project URL.',
			},
			{
				id: 'anon_key',
				label: 'Anon (public) key',
				type: 'password',
				required: true,
				secret: false,
				placeholder: 'eyJhbGciOiJI…',
				hint: 'Sealed into the Stronghold vault on save.',
			},
			{
				id: 'service_role_key',
				label: 'Service role key',
				type: 'password',
				required: false,
				secret: true,
				vaultKey: 'SUPABASE_SERVICE_ROLE_KEY',
				placeholder: 'Leave blank to skip admin pkgs',
				hint: 'Only needed for pkgs that opt into admin features. Never threaded to iframes.',
			},
		],
		write: async (values) => {
			const url = values.url?.trim();
			const anonKey = values.anon_key?.trim();
			if (!url || !anonKey) {
				throw new Error('Supabase URL and anon key are both required.');
			}
			await supabaseConfigSet(url, anonKey, values.service_role_key?.trim() || null);
			const serviceRole = values.service_role_key?.trim();
			if (serviceRole) {
				await secretsSet('SUPABASE_SERVICE_ROLE_KEY', serviceRole);
			}
		},
		status: async () => {
			const cfg = await supabaseConfigGet();
			if (!cfg) return 'not_configured';
			if (!cfg.url || !cfg.anonKey) return 'partial';
			return 'configured';
		},
		clear: async () => {
			await supabaseConfigClear();
			try {
				await secretsDelete('SUPABASE_SERVICE_ROLE_KEY');
			} catch {
				// best-effort — vault may be unavailable or key absent
			}
		},
		test: async (values) => {
			const url = values.url?.trim();
			const key = values.anon_key?.trim();
			if (!url || !key) {
				return { ok: false, message: 'Need a URL and anon key to test.' };
			}
			return await pingSupabase(url, key);
		},
	},
	// ─── Resend ──────────────────────────────────────────────────────────
	{
		id: 'resend',
		display: 'Resend',
		tagline: 'Transactional email sender used by pkgs that send mail on your behalf.',
		triggers: { vaultKeys: ['RESEND_API_KEY'] },
		fields: [
			{
				id: 'api_key',
				label: 'API key',
				type: 'password',
				required: true,
				secret: true,
				vaultKey: 'RESEND_API_KEY',
				placeholder: 're_…',
				hint: 'Generate one at resend.com/api-keys. Sealed into Stronghold on save.',
			},
		],
		write: async (values) => {
			const apiKey = values.api_key?.trim();
			if (!apiKey) throw new Error('Resend API key is required.');
			await secretsSet('RESEND_API_KEY', apiKey);
		},
		status: () => vaultKeyStatus(['RESEND_API_KEY']),
		clear: async () => {
			try {
				await secretsDelete('RESEND_API_KEY');
			} catch {
				// best-effort
			}
		},
	},
	// ─── Listmonk ────────────────────────────────────────────────────────
	{
		id: 'listmonk',
		display: 'Listmonk',
		tagline: 'Self-hosted newsletter sender for outbound campaigns.',
		triggers: { vaultKeys: ['LISTMONK_URL', 'LISTMONK_AUTH'] },
		fields: [
			{
				id: 'url',
				label: 'Server URL',
				type: 'url',
				required: true,
				secret: true,
				vaultKey: 'LISTMONK_URL',
				placeholder: 'https://newsletter.example.com',
				hint: 'The base URL of your Listmonk install (no trailing slash).',
			},
			{
				id: 'auth',
				label: 'Basic auth',
				type: 'password',
				required: true,
				secret: true,
				vaultKey: 'LISTMONK_AUTH',
				placeholder: 'username:password',
				hint: 'Listmonk currently only supports basic auth. Sealed into Stronghold.',
			},
		],
		write: async (values) => {
			const url = values.url?.trim();
			const auth = values.auth?.trim();
			if (!url || !auth) throw new Error('Listmonk URL and auth are both required.');
			await secretsSet('LISTMONK_URL', url);
			await secretsSet('LISTMONK_AUTH', auth);
		},
		status: () => vaultKeyStatus(['LISTMONK_URL', 'LISTMONK_AUTH']),
		clear: async () => {
			for (const key of ['LISTMONK_URL', 'LISTMONK_AUTH']) {
				try {
					await secretsDelete(key);
				} catch {
					// best-effort
				}
			}
		},
	},
	// ─── Twenty CRM ──────────────────────────────────────────────────────
	{
		id: 'twenty',
		display: 'Twenty CRM',
		tagline: 'Self-hosted CRM used by Sales / Outbound pkgs.',
		triggers: { vaultKeys: ['TWENTY_API_URL', 'TWENTY_API_KEY'] },
		fields: [
			{
				id: 'url',
				label: 'API URL',
				type: 'url',
				required: true,
				secret: true,
				vaultKey: 'TWENTY_API_URL',
				placeholder: 'https://crm.example.com/api/graphql',
				hint: 'The GraphQL endpoint of your Twenty install.',
			},
			{
				id: 'api_key',
				label: 'API key',
				type: 'password',
				required: true,
				secret: true,
				vaultKey: 'TWENTY_API_KEY',
				placeholder: 'eyJhbGciOi…',
				hint: 'Mint a long-lived API key in Twenty under Settings → API.',
			},
		],
		write: async (values) => {
			const url = values.url?.trim();
			const apiKey = values.api_key?.trim();
			if (!url || !apiKey) throw new Error('Twenty URL and API key are both required.');
			await secretsSet('TWENTY_API_URL', url);
			await secretsSet('TWENTY_API_KEY', apiKey);
		},
		status: () => vaultKeyStatus(['TWENTY_API_URL', 'TWENTY_API_KEY']),
		clear: async () => {
			for (const key of ['TWENTY_API_URL', 'TWENTY_API_KEY']) {
				try {
					await secretsDelete(key);
				} catch {
					// best-effort
				}
			}
		},
	},
	// ─── Stripe ──────────────────────────────────────────────────────────
	{
		id: 'stripe',
		display: 'Stripe',
		tagline: 'Payments + revenue tracking surface used by the Sales pkg.',
		triggers: { vaultKeys: ['STRIPE_SECRET_KEY'] },
		fields: [
			{
				id: 'secret_key',
				label: 'Secret key',
				type: 'password',
				required: true,
				secret: true,
				vaultKey: 'STRIPE_SECRET_KEY',
				placeholder: 'sk_live_…',
				hint: 'From Stripe → Developers → API keys. Sealed into Stronghold.',
			},
			{
				id: 'webhook_secret',
				label: 'Webhook secret',
				type: 'password',
				required: false,
				secret: true,
				vaultKey: 'STRIPE_WEBHOOK_SECRET',
				placeholder: 'whsec_… (optional)',
				hint: 'Only needed if a pkg listens to Stripe webhooks.',
			},
		],
		write: async (values) => {
			const secret = values.secret_key?.trim();
			if (!secret) throw new Error('Stripe secret key is required.');
			await secretsSet('STRIPE_SECRET_KEY', secret);
			const whsec = values.webhook_secret?.trim();
			if (whsec) await secretsSet('STRIPE_WEBHOOK_SECRET', whsec);
		},
		status: () => vaultKeyStatus(['STRIPE_SECRET_KEY']),
		clear: async () => {
			for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
				try {
					await secretsDelete(key);
				} catch {
					// best-effort
				}
			}
		},
	},
]);

// ---- Helpers ------------------------------------------------------------

export function findConnector(id: ConnectorId): ConnectorDef | undefined {
	return CONNECTOR_REGISTRY.find((c) => c.id === id);
}

/**
 * Generic vault-keys status read — `configured` iff every required key is
 * present, `partial` if some are present, `not_configured` otherwise. The
 * vault may be unavailable on this host (e.g. headless CI); in that case
 * we return `not_configured` so the UI prompts the user to set up keys
 * via the standard flow.
 */
async function vaultKeyStatus(required: string[]): Promise<ConnectorStatus> {
	let vaultOk = false;
	try {
		const status = await secretsVaultStatus();
		vaultOk = status.available;
	} catch {
		vaultOk = false;
	}
	if (!vaultOk) return 'not_configured';
	let known: string[] = [];
	try {
		known = await secretsListKeys();
	} catch {
		return 'not_configured';
	}
	const set = new Set(known);
	const present = required.filter((k) => set.has(k)).length;
	if (present === required.length) return 'configured';
	if (present === 0) return 'not_configured';
	return 'partial';
}

/**
 * Best-effort liveness ping for Supabase. Uses the documented anon-key
 * health endpoint (`/auth/v1/health`). 2xx → ok, any other status / network
 * failure → not ok with a brief message.
 */
async function pingSupabase(url: string, anonKey: string): Promise<ConnectorTestResult> {
	const base = url.replace(/\/+$/, '');
	const probe = `${base}/auth/v1/health`;
	try {
		const start = performance.now();
		const res = await fetch(probe, {
			method: 'GET',
			headers: {
				apikey: anonKey,
				Authorization: `Bearer ${anonKey}`,
			},
		});
		const elapsed = Math.round(performance.now() - start);
		if (res.ok) {
			return { ok: true, message: `Project responded in ${elapsed}ms.` };
		}
		return { ok: false, message: `Probe returned HTTP ${res.status}.` };
	} catch (err) {
		return { ok: false, message: (err as Error).message ?? 'Network error.' };
	}
}

// Re-export for callers that want to round-trip the supabase config shape.
export type { SupabaseConfig };

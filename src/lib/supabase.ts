import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { secretsGet, supabaseConfigGet } from './tauri-cmd';

// All Supabase config now lives in two app-data files:
//   - URL + anon key:    app_data_dir/supabase.json (non-secret manifest)
//   - service-role key:  Stronghold vault, key `SUPABASE_SERVICE_ROLE_KEY`
// No `.env.local` involvement. The desktop shell always reads via Tauri
// commands; vite's `import.meta.env.VITE_SUPABASE_*` are no longer consulted.

// Boot ordering: this module is loaded eagerly at FE startup. If the manifest
// is missing (first run, or after `supabase_config_clear`), we still export a
// `supabase` client built from harmless placeholders so callers don't crash
// on import — operations on it fail with a network error that the existing
// loading/error states already handle. Routes that gate on config availability
// can use `isSupabaseConfigured()` to render an empty state and link to the
// Settings panel.

const PLACEHOLDER_URL = 'http://supabase-not-configured.invalid';
const PLACEHOLDER_KEY = 'placeholder';

async function loadConfig(): Promise<{
	url: string;
	anonKey: string;
	authKey: string | null;
	source: 'configured' | 'placeholder';
}> {
	let url = PLACEHOLDER_URL;
	let anonKey = PLACEHOLDER_KEY;
	let source: 'configured' | 'placeholder' = 'placeholder';

	try {
		const cfg = await supabaseConfigGet();
		if (cfg) {
			url = cfg.url;
			anonKey = cfg.anonKey;
			source = 'configured';
		}
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn('[supabase] supabaseConfigGet threw (likely no Tauri runtime):', err);
	}

	let authKey: string | null = null;
	if (source === 'configured') {
		// Prefer the manifest's service_role_key (synchronous read, no Stronghold
		// KDF cost on this machine). Fall back to vault for migration cases where
		// the user has Stronghold working and the manifest doesn't carry the key.
		try {
			const cfg = await supabaseConfigGet();
			if (cfg?.serviceRoleKey) {
				authKey = cfg.serviceRoleKey;
			} else {
				authKey = await secretsGet('SUPABASE_SERVICE_ROLE_KEY');
			}
		} catch (err) {
			// eslint-disable-next-line no-console
			console.warn('[supabase] auth-key fetch threw:', err);
		}
	}

	return { url, anonKey, authKey, source };
}

const loaded = await loadConfig();

if (loaded.source === 'placeholder') {
	// eslint-disable-next-line no-console
	console.warn(
		'[supabase] not configured — open Settings → Supabase to add your project URL + anon key'
	);
} else if (!loaded.authKey) {
	// eslint-disable-next-line no-console
	console.warn(
		'[supabase] no service-role key in vault — calls will hit RLS as anon. Add SUPABASE_SERVICE_ROLE_KEY in Settings → API keys.'
	);
}

const globalHeaders = loaded.authKey
	? { Authorization: `Bearer ${loaded.authKey}`, apikey: loaded.authKey }
	: undefined;

export const supabase: SupabaseClient = createClient(loaded.url, loaded.anonKey, {
	auth: {
		persistSession: false,
		autoRefreshToken: false,
		detectSessionInUrl: false,
	},
	global: globalHeaders ? { headers: globalHeaders } : undefined,
});

let _configured = loaded.source === 'configured';

export function isSupabaseConfigured(): boolean {
	return _configured;
}

/// Test-only / settings-only hook to flip the configured flag without a full
/// app reload. Real callers should reload the window after writing config so
/// every importer of `supabase` rebuilds its client.
export function _markSupabaseConfigured(value: boolean): void {
	_configured = value;
}

// Compat shim: legacy `auth.ts` (and AuthModal) still import STUB_AUTH_ENABLED
// from this module. Service-role mode bypasses user auth entirely, so the
// stub-auth branch is effectively dead — export `false` so call sites compile
// until Batch 3 retires auth-modal/auth.ts.
export const STUB_AUTH_ENABLED = false;

import { createClient } from '@supabase/supabase-js';

// Real auth (PKCE) for the Tauri webview. The session is stored in the
// renderer's localStorage under a desktop-app-specific key so it does NOT
// collide with any browser session on the same machine.
//
// The static-JWT stub used in phase 1 is retained as a *dev-only* escape
// hatch — set VITE_DEV_FORCE_STUB_AUTH=true alongside VITE_SUPABASE_USER_JWT
// to bypass real auth (e.g. for snapshot tests / CI). In normal use the user
// signs in via /login and supabase-js handles refresh + persistence.

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const userJwt = import.meta.env.VITE_SUPABASE_USER_JWT;
const forceStub = import.meta.env.VITE_DEV_FORCE_STUB_AUTH === 'true';

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing — set them in .env.local'
  );
}

export const STUB_AUTH_ENABLED = forceStub && !!userJwt;

export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'ikenga-desktop-auth',
  },
  // Stub-auth fallback: only injected when VITE_DEV_FORCE_STUB_AUTH=true.
  // In normal runs this is undefined and the Authorization header comes from
  // the active Supabase session (managed by supabase-js).
  global: STUB_AUTH_ENABLED
    ? { headers: { Authorization: `Bearer ${userJwt}` } }
    : undefined,
});

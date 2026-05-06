import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, STUB_AUTH_ENABLED } from './supabase';

// Lightweight session hook — subscribes to supabase.auth changes and exposes
// the current session. Returns `loading: true` until the initial getSession
// call resolves so the route guard can avoid a flash of /login.
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  // When stub-auth is forced via VITE_DEV_FORCE_STUB_AUTH=true, treat the
  // app as authenticated (no real session, but the static JWT is on every
  // request via global headers).
  if (STUB_AUTH_ENABLED) {
    return { session: null, loading: false, isAuthed: true as const };
  }

  return { session, loading, isAuthed: !!session };
}

export async function signOut() {
  await supabase.auth.signOut();
}

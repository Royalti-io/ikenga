// Auth removed — the desktop shell uses a vault-backed service-role key.
// useSession is preserved as a stub so call sites don't break during the
// pkg-extraction migration.
export function useSession() {
	return { session: null as null, loading: false, isAuthed: true as const };
}

// Ngwa lifecycle-state vocabulary — the one non-component primitive shared
// between `ngwa-surface.tsx` (the mixed model+container file) and the
// components-only `ngwa-bits.tsx`. Lives in its own JSX-free module so
// `ngwa-bits.tsx` can stay Fast-Refresh-eligible (a file that exports React
// components AND runtime constants forces a full reload on every edit, which
// is exactly the HMR breakage that slowed safe-delete-guard iteration).

/** Lifecycle state of a scanned primitive (WP-03 added `linked`). */
export type ItemState = 'enabled' | 'disabled' | 'local' | 'orphaned' | 'linked';

export const STATE_WORD: Record<ItemState, string> = {
	enabled: 'Enabled',
	disabled: 'Disabled',
	local: 'Local',
	orphaned: 'Orphaned',
	linked: 'Linked',
};

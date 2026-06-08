import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { usePaneStore } from '@/lib/panes/pane-store';
import { queryKeys } from '@/lib/query-keys';
import { onPaActionPaused } from '@/lib/tauri-cmd';

/**
 * Shell-level listener for the approve-gate seam (WP-7). When an approve-aware
 * action pauses a batch (`pa-action-paused`), refresh the gate's query and open
 * `/outbox/approvals` in the focused pane so the operator sees the drafts.
 * Mount once at workspace level. Scope: plans/atelier/10-approve-gate-seam.md.
 */
export function usePaActionsListener(): void {
	const qc = useQueryClient();
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		void (async () => {
			unlisten = await onPaActionPaused(() => {
				qc.invalidateQueries({ queryKey: queryKeys.paActions.all });
				usePaneStore.getState().navigateFocused('/outbox/approvals');
			});
		})();
		return () => unlisten?.();
	}, [qc]);
}

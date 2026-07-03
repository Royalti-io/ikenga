// The approve-gate route (WP-6) — mounts the run-then-pause draft-review panel
// against live pa_action_drafts. Opened by `usePaActionsListener` on
// `pa-action-paused`. Scope: plans/atelier/10-approve-gate-seam.md.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { openSessionDialog } from '@/components/pkg/open-session-dialog';
import {
	deriveWorkerHealth,
	paActionsListQueryOptions,
	pausedDraftFromRow,
} from '@/lib/queries/pa-actions';
import { queryKeys } from '@/lib/query-keys';
import { paActionsCommit, paActionsReject, paActionsRetry, paActionsUpdate } from '@/lib/tauri-cmd';
import { ApproveGatePanel } from '@/shell/atelier/surfaces/approve-gate-panel';

function ApprovalsPage() {
	const qc = useQueryClient();
	// WP-11: poll while the surface is open so the client-side worker-liveness
	// derivation stays live (the strip's only clock is this query's freshness).
	const { data } = useQuery({ ...paActionsListQueryOptions(), refetchInterval: 15_000 });

	const drafts = useMemo(
		() =>
			(data ?? []).map(pausedDraftFromRow).filter((d): d is NonNullable<typeof d> => d !== null),
		[data]
	);

	// WP-11: worker health is a pure client-side derivation over the same rows —
	// no new IPC, no daemon heartbeat (design's honest-dead default).
	const health = useMemo(() => deriveWorkerHealth(data ?? []), [data]);

	const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.paActions.all });

	// The panel fires onApprove only AFTER its own 10s undo window elapses; commit
	// then flips the row to `committed` and emits pa-action-committed for the worker.
	const onApprove = (id: string) => void paActionsCommit(id).then(invalidate);
	const onReject = (id: string) => void paActionsReject(id).then(invalidate);
	// Re-queue a failed draft: failed → committed + event-wake the worker (WP-12 / G-09).
	const onRetry = (id: string) => void paActionsRetry(id).then(invalidate);
	// Fire-and-forget persist — the panel already reflects the edit locally.
	const onEdit = (id: string, patch: { subject?: string; body?: string }) =>
		void paActionsUpdate(id, patch);

	// Hand a draft off to a fresh Chi conversation seeded with its content.
	const handoff = (id: string) => {
		const d = drafts.find((x) => x.id === id);
		if (!d) return;
		void openSessionDialog({
			initialPrompt: `Refine this ${d.channel} draft to ${d.recipient}.\n\nSubject: ${d.subject}\n\n${d.body}`,
			source: 'approve-gate',
			sessionKind: 'chat',
		});
	};

	return (
		<div className="h-full bg-background">
			<ApproveGatePanel
				drafts={drafts}
				health={health}
				onApprove={onApprove}
				onReject={onReject}
				onEdit={onEdit}
				onRetry={onRetry}
				onSendToChat={handoff}
				onContinueSession={handoff}
			/>
		</div>
	);
}

export const Route = createFileRoute('/outbox/approvals')({
	component: ApprovalsPage,
});

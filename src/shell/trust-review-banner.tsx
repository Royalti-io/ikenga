// Workspace banner that appears when one or more installed pkgs are
// parked at boot pending capability review. Clicking "Review" opens the
// trust-review modal. Mounted alongside <UpdaterBanner /> and
// <ConnectorBanner /> in workspace.tsx — same visual lane.
//
// Polling cadence (15s) keeps the banner reasonably fresh without
// hammering SQLite. The boot-time `parked_for_review` count never
// changes during a session unless the user approves / rejects a row
// (both of which trigger a manual refresh), so a slow poll is fine.

import { ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { TrustReviewModal } from '@/components/pkg/trust-review-modal';
import { pkgTrustListPending, type PkgTrustReview } from '@/lib/tauri-cmd';

const POLL_INTERVAL_MS = 15_000;

export function TrustReviewBanner() {
	const [reviews, setReviews] = useState<PkgTrustReview[] | null>(null);
	const [modalOpen, setModalOpen] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const next = await pkgTrustListPending();
			setReviews(next);
		} catch (e) {
			// Best-effort: command surface may not be ready during very early
			// boot. Suppress noise; next tick will retry.
			// eslint-disable-next-line no-console
			console.debug('[trust-review] pkgTrustListPending failed', e);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const id = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
		return () => window.clearInterval(id);
	}, [refresh]);

	const count = reviews?.length ?? 0;
	if (count === 0) return null;

	return (
		<>
			<div className="flex items-center gap-3 border-b border-border bg-amber-100/40 px-4 py-2 text-sm dark:bg-amber-950/30">
				<ShieldAlert className="size-4 text-amber-700 dark:text-amber-400" />
				<div className="flex-1">
					<span className="font-medium">
						{count === 1 ? '1 package needs' : `${count} packages need`} capability review
					</span>
					<span className="text-muted-foreground">
						{' '}
						— parked until you approve or reject the changes.
					</span>
				</div>
				<Button size="sm" onClick={() => setModalOpen(true)}>
					Review
				</Button>
			</div>
			<TrustReviewModal
				open={modalOpen}
				onOpenChange={setModalOpen}
				initialReviews={reviews ?? []}
				onChange={() => void refresh()}
			/>
		</>
	);
}

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

import { Banner } from '@/components/ui/banner';
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
			<Banner
				tone="warning"
				icon={<ShieldAlert />}
				actions={
					<Button size="sm" onClick={() => setModalOpen(true)}>
						Review
					</Button>
				}
			>
				<span className="font-medium">
					{count === 1 ? '1 package needs' : `${count} packages need`} capability review
				</span>
				<span className="text-muted-foreground">
					{' '}
					— parked until you approve or reject the changes.
				</span>
			</Banner>
			<TrustReviewModal
				open={modalOpen}
				onOpenChange={setModalOpen}
				initialReviews={reviews ?? []}
				onChange={() => void refresh()}
			/>
		</>
	);
}

// Trust-review modal (2026-05-15) — batch surface for pkgs whose declared
// capabilities + permissions changed across an upgrade. The kernel parks
// these pkgs out of the registry replay at boot; the user approves
// (re-register + start) or rejects (uninstall) per row.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import {
	pkgTrustApprove,
	pkgTrustListPending,
	pkgTrustReject,
	type PkgTrustReview,
} from '@/lib/tauri-cmd';

/** Exported for unit tests — pretty-prints normalized snapshot JSON. */
export function _formatJson(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

const formatJson = _formatJson;

export interface TrustReviewModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Optional pre-loaded list so the banner can avoid a second fetch on open. */
	initialReviews?: PkgTrustReview[];
	/** Called after any successful Approve / Reject so the banner can refresh. */
	onChange?: () => void;
}

export function TrustReviewModal({
	open,
	onOpenChange,
	initialReviews,
	onChange,
}: TrustReviewModalProps) {
	const [reviews, setReviews] = useState<PkgTrustReview[]>(initialReviews ?? []);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const next = await pkgTrustListPending();
			setReviews(next);
			if (next.length === 0) {
				onOpenChange(false);
			}
		} catch (e) {
			setError(String(e));
		}
	}, [onOpenChange]);

	useEffect(() => {
		if (open && !initialReviews) {
			void refresh();
		}
	}, [open, initialReviews, refresh]);

	const handleApprove = useCallback(
		async (pkgId: string) => {
			setPendingId(pkgId);
			setError(null);
			try {
				await pkgTrustApprove(pkgId);
				onChange?.();
				await refresh();
			} catch (e) {
				setError(String(e));
			} finally {
				setPendingId(null);
			}
		},
		[onChange, refresh]
	);

	const handleReject = useCallback(
		async (pkgId: string) => {
			setPendingId(pkgId);
			setError(null);
			try {
				await pkgTrustReject(pkgId);
				onChange?.();
				await refresh();
			} catch (e) {
				setError(String(e));
			} finally {
				setPendingId(null);
			}
		},
		[onChange, refresh]
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-4xl">
				<DialogHeader>
					<DialogTitle>Capability review</DialogTitle>
					<DialogDescription>
						These packages declared new or changed capabilities since you last approved them. Review
						the diff and approve (resume the package) or reject (uninstall it).
					</DialogDescription>
				</DialogHeader>

				{error && (
					<div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
						{error}
					</div>
				)}

				{reviews.length === 0 ? (
					<div className="py-6 text-center text-sm text-muted-foreground">
						No packages pending review.
					</div>
				) : (
					<div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
						{reviews.map((r) => (
							<div
								key={r.pkg_id}
								data-testid={`trust-review-row-${r.pkg_id}`}
								className="rounded border border-border bg-card p-3"
							>
								<div className="mb-2 flex items-center justify-between gap-3">
									<div className="min-w-0">
										<div className="truncate font-mono text-sm font-medium">{r.pkg_id}</div>
										<div className="text-xs text-muted-foreground">
											manifest version {r.manifest_version}
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-2">
										<Button
											size="sm"
											variant="outline"
											disabled={pendingId === r.pkg_id}
											onClick={() => void handleReject(r.pkg_id)}
											data-testid={`trust-review-reject-${r.pkg_id}`}
										>
											Reject
										</Button>
										<Button
											size="sm"
											disabled={pendingId === r.pkg_id}
											onClick={() => void handleApprove(r.pkg_id)}
											data-testid={`trust-review-approve-${r.pkg_id}`}
										>
											{pendingId === r.pkg_id ? 'Working…' : 'Approve'}
										</Button>
									</div>
								</div>
								<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
									<div>
										<div className="mb-1 text-xs font-medium text-muted-foreground">
											Previously approved
										</div>
										<pre className="max-h-64 overflow-auto rounded border border-border bg-muted/50 p-2 text-xs">
											{formatJson(r.old_capabilities)}
										</pre>
									</div>
									<div>
										<div className="mb-1 text-xs font-medium text-muted-foreground">Current</div>
										<pre className="max-h-64 overflow-auto rounded border border-border bg-muted/50 p-2 text-xs">
											{formatJson(r.new_capabilities)}
										</pre>
									</div>
								</div>
							</div>
						))}
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

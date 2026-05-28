// Headless background pkg auto-updater. Mounted once in the workspace
// alongside <UpdaterBanner /> (which owns the app-binary side). Mounting
// usePkgsDerived here is what performs the boot-time + 6h registry check for
// pkg updates — the activity-bar badge and /packages surface subscribe to the
// same queries.
//
// When `updates.autoCheck` AND `updates.autoInstallPkgs` are both on, any
// outdated pkg is updated in place silently — pkgs are sandboxed and
// hot-reload via the kernel's `pkg-reloaded` event, so there's no relaunch and
// the surprise cost is low (unlike an app-binary update). A small dismissible
// strip confirms what was updated; when auto-install is off, the existing
// badge + /packages "Update all" strip surface the updates instead.

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { usePkgsDerived } from '@/lib/pkgs/use-derived';
import { useUpdatePkgs, type UpdateProgress } from '@/lib/pkgs/use-update-pkgs';
import { useShellStore } from '@/lib/shell/shell-store';

export function PkgAutoUpdater() {
	const autoCheck = useShellStore((s) => s.updatesAutoCheck);
	const autoInstallPkgs = useShellStore((s) => s.updatesAutoInstallPkgs);
	const d = usePkgsDerived();
	const updatePkgs = useUpdatePkgs();
	// id@latest of every update we've already kicked off this session, so a
	// query refetch (or the post-update invalidation) can't re-trigger the
	// same upgrade. A genuinely newer release later still fires (different key).
	const attempted = useRef<Set<string>>(new Set());
	const [progress, setProgress] = useState<UpdateProgress | null>(null);
	const [doneCount, setDoneCount] = useState<number | null>(null);

	useEffect(() => {
		if (!autoCheck || !autoInstallPkgs) return;
		if (updatePkgs.isPending || !d.updates.length) return;
		const fresh = d.updates.filter((r) => !attempted.current.has(`${r.id}@${r.latest}`));
		if (!fresh.length) return;
		for (const r of fresh) attempted.current.add(`${r.id}@${r.latest}`);
		updatePkgs.mutate(
			{ rows: fresh, onProgress: setProgress },
			{
				onSuccess: (n) => {
					if (n > 0) setDoneCount(n);
				},
				onSettled: () => setProgress(null),
			}
		);
	}, [autoCheck, autoInstallPkgs, d.updates, updatePkgs]);

	if (progress) {
		return (
			<div className="flex items-center gap-3 border-b border-border bg-muted/50 px-4 py-2 text-sm">
				<Loader2 className="size-4 animate-spin text-foreground" />
				<div className="flex-1">
					Updating <span className="font-medium">{progress.current || 'packages'}</span> (
					{progress.done}/{progress.total})…
				</div>
			</div>
		);
	}

	if (doneCount && doneCount > 0) {
		return (
			<div className="flex items-center gap-3 border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm">
				<CheckCircle2 className="size-4 text-emerald-500" />
				<div className="flex-1">
					Updated <span className="font-medium">{doneCount}</span> package
					{doneCount === 1 ? '' : 's'}.
				</div>
				<button
					type="button"
					onClick={() => setDoneCount(null)}
					className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					aria-label="Dismiss"
				>
					<X className="size-3.5" />
				</button>
			</div>
		);
	}

	// Render nothing in the common case; the badge + /packages "Update all"
	// strip carry the non-auto-install path.
	return null;
}

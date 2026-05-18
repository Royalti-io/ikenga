// Workspace banner that appears when a newer release is available on the
// updater endpoint. Click "Update now" → download + verify sig + install +
// relaunch. Drop-in alongside the existing ConnectorBanner — same surface
// area, different signal.
//
// Snooze model: when the user clicks the "×" we silence this banner for 24h
// (per-version, so a fresh release un-silences automatically). The About
// page at /settings/about stays visible regardless of snooze.

import { Download, RefreshCw, X } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useUpdater } from '@/lib/updater/use-updater';
import { useUpdaterSnooze } from '@/lib/updater/snooze';

export function UpdaterBanner() {
	const { available, installing, bytesDownloaded, totalBytes, error, install } = useUpdater();
	const snooze = useUpdaterSnooze();
	const isSnoozed = snooze.isSnoozed(available?.version ?? null);
	// Hide on /settings/about — the user is already on the dedicated surface
	// for shell updates, so the banner is redundant noise there.
	const onAboutPage = usePaneStore(
		useShallow((s) => {
			const leaf = findLeaf(s.root, s.focusedId);
			if (!leaf) return false;
			const tab = leaf.tabs[leaf.activeTabIdx];
			if (!tab || tab.kind !== 'route') return false;
			return tab.path.split('?')[0] === '/settings/about';
		})
	);

	if (onAboutPage) return null;
	if (!available && !error) return null;
	if (available && isSnoozed) return null;

	if (error) {
		return (
			<div className="flex items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm">
				<RefreshCw className="size-4 text-destructive" />
				<div className="flex-1">Update failed: {error}</div>
				<Link
					to="/settings/about"
					className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
				>
					About →
				</Link>
			</div>
		);
	}

	const pct =
		totalBytes && totalBytes > 0
			? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100))
			: null;

	return (
		<div className="flex items-center gap-3 border-b border-border bg-muted/50 px-4 py-2 text-sm">
			<Download className="size-4 text-foreground" />
			<div className="flex-1">
				<span className="font-medium">Ikenga {available!.version}</span>
				<span className="text-muted-foreground"> is available.</span>
				{installing && pct !== null && (
					<span className="text-muted-foreground"> Downloading {pct}%…</span>
				)}
				{installing && pct === null && <span className="text-muted-foreground"> Downloading…</span>}
			</div>
			<Link
				to="/settings/about"
				className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
			>
				Release notes →
			</Link>
			<Button size="sm" onClick={() => void install()} disabled={installing}>
				{installing ? 'Installing…' : 'Update now'}
			</Button>
			{!installing && (
				<button
					type="button"
					onClick={() => snooze.snooze(available!.version)}
					className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					title="Defer for 24h"
					aria-label="Defer for 24h"
				>
					<X className="size-3.5" />
				</button>
			)}
		</div>
	);
}

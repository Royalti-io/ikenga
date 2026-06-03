// Workspace banner that appears when a newer release is available on the
// updater endpoint. Click "Update now" → download + verify sig + install +
// relaunch. Drop-in alongside the existing ConnectorBanner — same surface
// area, different signal.
//
// Snooze model: when the user clicks the "×" we silence this banner for 24h
// (per-version, so a fresh release un-silences automatically). The About
// page at /settings/about stays visible regardless of snooze.

import { Download, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { useShallow } from 'zustand/react/shallow';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useShellStore } from '@/lib/shell/shell-store';
import { useUpdater } from '@/lib/updater/use-updater';
import { useUpdaterSnooze } from '@/lib/updater/snooze';

export function UpdaterBanner() {
	const autoCheck = useShellStore((s) => s.updatesAutoCheck);
	const autoInstallApp = useShellStore((s) => s.updatesAutoInstallApp);
	const { available, installing, bytesDownloaded, totalBytes, error, install } = useUpdater({
		enabled: autoCheck,
	});
	const snooze = useUpdaterSnooze();
	const isSnoozed = snooze.isSnoozed(available?.version ?? null);

	// Opt-in (default off): when `updates.autoInstallApp` is on, a detected
	// binary update downloads + relaunches without a click. Snooze still wins
	// as the escape hatch, and we never re-fire while a download is in flight.
	useEffect(() => {
		if (autoInstallApp && available && !isSnoozed && !installing && !error) {
			void install();
		}
	}, [autoInstallApp, available, isSnoozed, installing, error, install]);
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
			<Banner
				tone="danger"
				icon={<RefreshCw />}
				actions={
					<Link
						to="/settings/about"
						className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
					>
						About →
					</Link>
				}
			>
				Update failed: {error}
			</Banner>
		);
	}

	const pct =
		totalBytes && totalBytes > 0
			? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100))
			: null;

	return (
		<Banner
			tone="info"
			icon={<Download />}
			onDismiss={installing ? undefined : () => snooze.snooze(available!.version)}
			dismissLabel="Defer for 24h"
			actions={
				<>
					<Link
						to="/settings/about"
						className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
					>
						Release notes →
					</Link>
					<Button size="sm" onClick={() => void install()} disabled={installing}>
						{installing ? 'Installing…' : 'Update now'}
					</Button>
				</>
			}
		>
			<span className="font-medium">Ikenga {available!.version}</span>
			<span className="text-muted-foreground"> is available.</span>
			{installing && pct !== null && (
				<span className="text-muted-foreground"> Downloading {pct}%…</span>
			)}
			{installing && pct === null && <span className="text-muted-foreground"> Downloading…</span>}
		</Banner>
	);
}

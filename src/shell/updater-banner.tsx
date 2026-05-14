// Workspace banner that appears when a newer release is available on the
// updater endpoint. Click "Update now" → download + verify sig + install +
// relaunch. Drop-in alongside the existing ConnectorBanner — same surface
// area, different signal.

import { Download, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUpdater } from '@/lib/updater/use-updater';

export function UpdaterBanner() {
	const { available, installing, bytesDownloaded, totalBytes, error, install } = useUpdater();

	if (!available && !error) return null;

	if (error) {
		return (
			<div className="flex items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm">
				<RefreshCw className="size-4 text-destructive" />
				<div className="flex-1">Update failed: {error}</div>
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
			<Button size="sm" onClick={() => void install()} disabled={installing}>
				{installing ? 'Installing…' : 'Update now'}
			</Button>
		</div>
	);
}

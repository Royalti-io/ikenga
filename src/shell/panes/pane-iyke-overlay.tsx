// Per-pane "iyke is doing something" overlay.
//
// Shows a thin shimmering line at the top of the pane content area plus a
// small chip in the top-right corner. Both are absolutely positioned and
// pointer-events: none on the wrapper — clicks pass straight through to the
// underlying pane content. The chip itself flips pointer-events back on so
// it remains clickable (opens the recent-logs sheet).
//
// Activity state lives in `useIykeActivity` (in-memory only). Begin/end
// calls are issued by the iyke bridge handlers and the screenshot listener;
// see `src/lib/iyke/activity-store.ts`.

import { useMemo, useState } from 'react';

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@/components/ui/sheet';
import { iykeFetch } from '@/lib/iyke/client';
import {
	useIykeActivity,
	type IykeActivity,
	type IykeActivityKind,
} from '@/lib/iyke/activity-store';
import { cn } from '@/components/ui/utils';

interface PaneIykeOverlayProps {
	paneId: string;
}

const KIND_LABEL: Record<IykeActivityKind, string> = {
	screenshot: 'screenshot',
	click: 'click',
	type: 'type',
	key: 'key',
	dom: 'dom',
	'query-cache': 'queries',
	wait: 'wait',
};

export function PaneIykeOverlay({ paneId }: PaneIykeOverlayProps) {
	const activities = useIykeActivity((s) => s.byScope[paneId]);
	const [logsOpen, setLogsOpen] = useState(false);

	// Most-recent activity drives the chip label.
	const top: IykeActivity | undefined = activities?.[activities.length - 1];

	if (!top) return null;

	return (
		<>
			<div
				className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
				aria-hidden="false"
				aria-live="polite"
				data-iyke-overlay={paneId}
			>
				{/* Top-edge shimmer line (gradient sliver moving left → right). */}
				<div className="absolute left-0 right-0 top-0 h-[2px] overflow-hidden bg-foreground/10">
					<div
						className={cn(
							'iyke-shimmer h-full w-1/3',
							'bg-gradient-to-r from-transparent via-foreground/60 to-transparent'
						)}
					/>
				</div>

				{/* Corner chip — pointer-events re-enabled so it's clickable. */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						setLogsOpen(true);
					}}
					aria-label={`iyke ${KIND_LABEL[top.kind]} on this pane — open logs`}
					className={cn(
						'pointer-events-auto absolute right-1.5 top-1.5',
						'flex items-center gap-1.5',
						'rounded-md border border-border bg-background/80 px-1.5 py-0.5',
						'text-[10px] font-medium leading-none text-foreground/80',
						'shadow-sm backdrop-blur',
						'hover:bg-background hover:text-foreground'
					)}
					title="iyke is acting on this pane — click to view logs"
				>
					<span className="relative inline-block h-1.5 w-1.5">
						<span className="absolute inset-0 animate-ping rounded-full bg-foreground/50" />
						<span className="absolute inset-0 rounded-full bg-foreground/80" />
					</span>
					<span>iyke · {KIND_LABEL[top.kind]}</span>
					{activities && activities.length > 1 && (
						<span className="text-foreground/50">+{activities.length - 1}</span>
					)}
				</button>
			</div>

			<IykeLogsSheet open={logsOpen} onOpenChange={setLogsOpen} paneId={paneId} />
		</>
	);
}

// ── Logs sheet ────────────────────────────────────────────────────────────────

interface LogEntry {
	ts: number;
	level: string;
	message: string;
	source?: string;
}

interface LogsSheetProps {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	paneId: string;
}

function IykeLogsSheet({ open, onOpenChange, paneId }: LogsSheetProps) {
	const [entries, setEntries] = useState<LogEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Fetch on every open. Cheap (localhost) and avoids stale buffers when the
	// user opens the sheet a second time during a different activity.
	useMemo(() => {
		if (!open) return;
		setEntries(null);
		setError(null);
		void (async () => {
			try {
				const res = await iykeFetch('/iyke/logs');
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const body = (await res.json()) as { entries: LogEntry[] };
				setEntries(body.entries.slice(-200).reverse());
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		})();
	}, [open]);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-[640px] max-w-full sm:w-[640px]">
				<SheetHeader>
					<SheetTitle>Iyke logs</SheetTitle>
					<SheetDescription>
						Recent FE log entries from the iyke bridge buffer. Pane{' '}
						<code className="rounded bg-muted px-1 py-0.5 text-xs">{paneId}</code>.
					</SheetDescription>
				</SheetHeader>
				<div className="mt-4 h-[calc(100vh-8rem)] overflow-y-auto rounded border border-border bg-muted/30 p-2 font-mono text-[11px] leading-snug">
					{error && <div className="text-destructive">Failed to load: {error}</div>}
					{!error && entries === null && <div className="text-muted-foreground">Loading…</div>}
					{!error && entries && entries.length === 0 && (
						<div className="text-muted-foreground">No log entries.</div>
					)}
					{!error &&
						entries?.map((e, i) => (
							<div
								key={`${e.ts}-${i}`}
								className={cn(
									'whitespace-pre-wrap break-words py-0.5',
									e.level === 'error' && 'text-destructive',
									e.level === 'warn' && 'text-amber-700 dark:text-amber-400'
								)}
							>
								<span className="text-muted-foreground">
									{new Date(e.ts).toLocaleTimeString()}{' '}
								</span>
								<span className="font-semibold uppercase">{e.level}</span>{' '}
								{e.source && <span className="text-muted-foreground">[{e.source}] </span>}
								<span>{e.message}</span>
							</div>
						))}
				</div>
			</SheetContent>
		</Sheet>
	);
}

// Sink picker for the Studio loupe.
//
// Lets the user choose where pin clicks from inside this artifact get
// routed: terminal claude (default when one's running), side-pane
// Chat, the Studio's own chat rail, both terminal+sidepane, or auto
// (let the dispatcher pick). The choice is per-artifact, persisted in
// `settings_kv` under `artifact-studio.sink.<path>`.
//
// Falls through to the folder-level `default-sink` (artifact-grid
// settings) and ultimately to the global default when no override is
// set. v0 of the loupe surfaces just the per-artifact override; the
// folder + global controls live at `/settings/artifact-grid`.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import {
	type ForegroundProcess,
	type RouteSink,
	ptyForegroundSnapshot,
	settingsGet,
	settingsSet,
} from '@/lib/tauri-cmd';
import { useTerminalStore } from '@/terminal/session-store';

/** Per-artifact sink override.
 *
 * - `inherit` — follow folder-level / global default (no override).
 * - `auto` — let the Rust dispatcher pick (claude PTY when present,
 *   side-pane fallback otherwise).
 * - `terminal` — always write to the active claude (or claude-family)
 *   PTY. Falls back to side-pane silently if none exists.
 * - `sidepane` — emit `pin://routed` for the side-pane Chat thread.
 * - `studio` — route into the Studio's own chat rail (loupe-local;
 *   only meaningful from inside the loupe).
 * - `both` — terminal + side-pane simultaneously (mirror mode).
 * - `terminal:<ptyId>` — pin to a specific live PTY (encoded as
 *   `terminal:<id>`). Route override collapses to `'terminal'`; the
 *   `<id>` suffix is threaded through as `preferred_pty_id` so the Rust
 *   dispatcher prefers that PTY over the focused-tab fallback.
 */
export type StudioSink =
	| 'inherit'
	| 'auto'
	| 'terminal'
	| 'sidepane'
	| 'studio'
	| 'both'
	| `terminal:${string}`;

const SINK_KEY = (path: string) => `artifact-studio.sink.${path}`;
const QK = (path: string) => ['artifact-studio', 'sink', path] as const;

const TERMINAL_ID_RE = /^terminal:([A-Za-z0-9_-]+)$/;

function parseSink(raw: string | null): StudioSink {
	if (
		raw === 'inherit' ||
		raw === 'auto' ||
		raw === 'terminal' ||
		raw === 'sidepane' ||
		raw === 'studio' ||
		raw === 'both'
	) {
		return raw;
	}
	if (raw && TERMINAL_ID_RE.test(raw)) {
		return raw as StudioSink;
	}
	return 'inherit';
}

/** Translate a Studio-level sink choice to the Rust `RouteSink` shape that
 *  `commentRoute` accepts. `studio` and `auto`/`inherit` produce
 *  `undefined` so the dispatcher's existing auto-detect runs. (The
 *  Studio-chat-rail sink needs a new `RouteSink::Studio` variant on the
 *  Rust side; until that lands, it falls back to auto.) */
export function studioSinkToRouteOverride(sink: StudioSink): RouteSink | undefined {
	if (typeof sink === 'string' && sink.startsWith('terminal:')) return 'terminal';
	switch (sink) {
		case 'terminal':
			return 'terminal';
		case 'sidepane':
			return 'sidepane';
		case 'both':
			return 'both';
		case 'auto':
		case 'inherit':
		case 'studio':
			return undefined;
	}
}

/** If `sink` encodes a specific PTY (`terminal:<id>`), return the id;
 *  otherwise `null`. Used by pin routing call sites to populate the
 *  `preferred_pty_id` hint on the Rust dispatcher. */
export function studioSinkToPreferredPtyId(sink: StudioSink): string | null {
	if (typeof sink !== 'string') return null;
	const m = sink.match(TERMINAL_ID_RE);
	return m ? m[1] : null;
}

/** Read the persisted per-artifact sink override without subscribing to a
 *  query. Used by the pin-composer at routing time. Returns the raw
 *  `StudioSink`; the caller decides whether to inherit. */
export async function readArtifactSink(path: string): Promise<StudioSink> {
	try {
		return parseSink(await settingsGet(SINK_KEY(path)));
	} catch {
		return 'inherit';
	}
}

export function useArtifactSink(path: string) {
	const qc = useQueryClient();
	const query = useQuery({
		queryKey: QK(path),
		queryFn: async () => parseSink(await settingsGet(SINK_KEY(path))),
		staleTime: 5_000,
	});
	const sink: StudioSink = query.data ?? 'inherit';

	const setSink = useCallback(
		async (next: StudioSink) => {
			await settingsSet(SINK_KEY(path), next === 'inherit' ? '' : next);
			qc.setQueryData(QK(path), next);
		},
		[path, qc]
	);

	return { sink, setSink };
}

interface StudioSinkPopoverProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	anchorEl: HTMLElement | null;
	sink: StudioSink;
	onSinkChange: (next: StudioSink) => void | Promise<void>;
}

/** Sinks that map 1:1 to a static label (everything except the per-PTY
 *  `terminal:<id>` form, whose label is computed from the live tab). */
type BasicSink = Exclude<StudioSink, `terminal:${string}`>;

const ORDER: BasicSink[] = ['inherit', 'auto', 'studio', 'terminal', 'sidepane', 'both'];

const LABELS: Record<BasicSink, { title: string; subtitle: string }> = {
	inherit: { title: 'Follow folder default', subtitle: '(unset — use folder / global default)' },
	auto: { title: 'Auto', subtitle: 'Terminal claude when present, side-pane Chat otherwise' },
	studio: { title: 'Studio chat', subtitle: 'This loupe’s chat rail thread' },
	terminal: {
		title: 'Terminal — Auto-detect claude PTY',
		subtitle: 'First running claude/codex/gemini PTY',
	},
	sidepane: { title: 'Side-pane Chat', subtitle: 'Workspace-wide side-pane thread' },
	both: { title: 'Mirror (both)', subtitle: 'Terminal *and* side-pane' },
};

export function StudioSinkPopover({
	open,
	onOpenChange,
	anchorEl,
	sink,
	onSinkChange,
}: StudioSinkPopoverProps) {
	const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

	// Live PTYs surfaced under a "Terminals" subsection. Subscribe to the
	// store's tabs slice; filter to tabs with a live ptyId. Same query key
	// as grid.tsx so the snapshot is shared and refetched every 5s.
	const liveTabs = useTerminalStore((s) =>
		s.tabs.filter((t): t is typeof t & { ptyId: string } => t.ptyId !== null)
	);
	const foregroundQuery = useQuery({
		queryKey: ['pty-foreground-snapshot'],
		queryFn: () => ptyForegroundSnapshot(),
		refetchInterval: 5_000,
		enabled: open,
	});
	const foreground: Record<string, ForegroundProcess> = foregroundQuery.data ?? {};

	// If the saved sink is `terminal:<id>` and that PTY isn't live, surface
	// a greyed `(missing)` row so the user can see what they picked.
	const savedTerminalId = studioSinkToPreferredPtyId(sink);
	const missingTerminalId = useMemo(() => {
		if (!savedTerminalId) return null;
		const stillLive = liveTabs.some((t) => t.ptyId === savedTerminalId);
		return stillLive ? null : savedTerminalId;
	}, [savedTerminalId, liveTabs]);

	useEffect(() => {
		if (!open || !anchorEl) {
			setPos(null);
			return;
		}
		const rect = anchorEl.getBoundingClientRect();
		// Anchor below the trigger button, right-aligned with it. Reading
		// from `right` (viewport - rect.right) so the popover hangs to the
		// left of the toolbar — same edge as the chrome buttons.
		setPos({
			top: rect.bottom + 4,
			right: window.innerWidth - rect.right,
		});
	}, [open, anchorEl]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onOpenChange(false);
		};
		const onDoc = (e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			if (t && t.closest('[data-studio-sink-popover]')) return;
			if (t && anchorEl && anchorEl.contains(t)) return;
			onOpenChange(false);
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('mousedown', onDoc, true);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('mousedown', onDoc, true);
		};
	}, [open, anchorEl, onOpenChange]);

	if (!open || !pos) return null;

	return (
		<div
			data-studio-sink-popover
			className="fixed z-50 min-w-[260px] rounded border border-border bg-background shadow-lg"
			style={{ top: pos.top, right: pos.right }}
			role="menu"
			aria-label="Pin routing sink"
		>
			<div className="border-b border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
				Pin → where?
			</div>
			<ul className="py-1">
				{ORDER.map((opt) => {
					const isActive = sink === opt;
					const { title, subtitle } = LABELS[opt];
					return (
						<li key={opt}>
							<button
								type="button"
								role="menuitemradio"
								aria-checked={isActive}
								onClick={() => {
									void onSinkChange(opt);
									onOpenChange(false);
								}}
								className={cn(
									'flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors',
									'hover:bg-foreground/5',
									isActive && 'bg-foreground/5'
								)}
							>
								<Check
									className={cn(
										'mt-0.5 h-3 w-3 shrink-0',
										isActive ? 'text-foreground' : 'text-transparent'
									)}
								/>
								<span className="flex-1 min-w-0">
									<span className="block text-xs text-foreground">{title}</span>
									<span className="block text-[10px] text-muted-foreground">{subtitle}</span>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
			{(liveTabs.length > 0 || missingTerminalId) && (
				<>
					<div className="border-t border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
						Terminals
					</div>
					<ul className="py-1">
						{liveTabs.map((tab) => {
							const opt = `terminal:${tab.ptyId}` as StudioSink;
							const isActive = sink === opt;
							const fg = foreground[tab.ptyId];
							const title = `${tab.title} · ${tab.ptyId.slice(0, 6)}`;
							const subtitle = fg ? fg.name : '—';
							return (
								<li key={tab.id}>
									<button
										type="button"
										role="menuitemradio"
										aria-checked={isActive}
										onClick={() => {
											void onSinkChange(opt);
											onOpenChange(false);
										}}
										className={cn(
											'flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors',
											'hover:bg-foreground/5',
											isActive && 'bg-foreground/5'
										)}
									>
										<Check
											className={cn(
												'mt-0.5 h-3 w-3 shrink-0',
												isActive ? 'text-foreground' : 'text-transparent'
											)}
										/>
										<span className="flex-1 min-w-0">
											<span className="block text-xs text-foreground">{title}</span>
											<span className="block text-[10px] text-muted-foreground">{subtitle}</span>
										</span>
									</button>
								</li>
							);
						})}
						{missingTerminalId && (
							<li key={`missing:${missingTerminalId}`}>
								<div
									className="flex w-full items-start gap-2 px-3 py-1.5 text-left opacity-50"
									title="The PTY this sink referenced is no longer running. Pick another sink to clear."
								>
									<Check className="mt-0.5 h-3 w-3 shrink-0 text-foreground" />
									<span className="flex-1 min-w-0">
										<span className="block text-xs text-foreground">
											term {missingTerminalId.slice(0, 6)}
										</span>
										<span className="block text-[10px] text-muted-foreground">(missing)</span>
									</span>
								</div>
							</li>
						)}
					</ul>
				</>
			)}
		</div>
	);
}

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

import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { type RouteSink, settingsGet, settingsSet } from '@/lib/tauri-cmd';

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
 */
export type StudioSink = 'inherit' | 'auto' | 'terminal' | 'sidepane' | 'studio' | 'both';

const SINK_KEY = (path: string) => `artifact-studio.sink.${path}`;
const QK = (path: string) => ['artifact-studio', 'sink', path] as const;

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
	return 'inherit';
}

/** Translate a Studio-level sink choice to the Rust `RouteSink` shape that
 *  `commentRoute` accepts. `studio` and `auto`/`inherit` produce
 *  `undefined` so the dispatcher's existing auto-detect runs. (The
 *  Studio-chat-rail sink needs a new `RouteSink::Studio` variant on the
 *  Rust side; until that lands, it falls back to auto.) */
export function studioSinkToRouteOverride(sink: StudioSink): RouteSink | undefined {
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

const ORDER: StudioSink[] = ['inherit', 'auto', 'studio', 'terminal', 'sidepane', 'both'];

const LABELS: Record<StudioSink, { title: string; subtitle: string }> = {
	inherit: { title: 'Follow folder default', subtitle: '(unset — use folder / global default)' },
	auto: { title: 'Auto', subtitle: 'Terminal claude when present, side-pane Chat otherwise' },
	studio: { title: 'Studio chat', subtitle: 'This loupe’s chat rail thread' },
	terminal: { title: 'Terminal', subtitle: 'Active claude/codex/gemini PTY' },
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
		</div>
	);
}

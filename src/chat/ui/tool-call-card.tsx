/**
 * Single tool-use ↔ tool-result pair, rendered as a ritual pill.
 *
 * Ritual pill (the only collapsed view): kola-amber ◾ glyph + tool title
 * + status hint. Click toggles an inline expanded panel rendered through
 * the per-tool renderer at `density='full'`. The expanded panel caps at
 * 320px scroll-height and surfaces an "Open in viewer ↗" CTA so heavy
 * output can be opened in a dedicated viewer pane (phase 2 will wire
 * the viewer; in phase 1 the CTA logs a warn).
 *
 * When `isChild` is true (Task subagent children), the pill chrome is
 * omitted — the child renders inline as part of its parent's tree.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, CircleAlert, Loader2 } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { usePaneStore } from '@/lib/panes/pane-store';
import type { PairedToolCall } from '../store';
import { ToolRendererDispatch } from './tool-renderers';

interface ToolCallCardProps {
	pair: PairedToolCall;
	threadId: string;
	/** When true, render as a nested child (no pill chrome). Used by
	 *  TaskRenderer for subagent children. */
	isChild?: boolean;
}

export function ToolCallCard({ pair, threadId, isChild }: ToolCallCardProps) {
	const isError = pair.result?.isError === true;
	const isPending = pair.result == null;
	const title = deriveTitle(pair);
	const [open, setOpen] = useState(isError);
	const focusedId = usePaneStore((s) => s.focusedId);
	const addTab = usePaneStore((s) => s.addTab);

	if (isChild) {
		// Children render at full density without pill chrome — they sit
		// inside the parent Task's expanded panel and already inherit its
		// scroll cap.
		return <ToolRendererDispatch pair={pair} threadId={threadId} density="full" />;
	}

	function handleOpenInViewer() {
		// ADR-011 phase 2: open this tool output in a dedicated pane tab.
		// The viewer dedupes by (threadId, toolUseId) so clicking twice
		// focuses the existing tab rather than spawning a duplicate.
		addTab(focusedId, {
			kind: 'tool-output',
			threadId,
			toolUseId: pair.use.id,
		});
	}

	return (
		<div className="space-y-2">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className={cn(
					'group inline-flex max-w-full items-center gap-2 rounded-full border bg-transparent py-1 pl-2.5 pr-3 text-left transition-colors hover:bg-[var(--rule-soft)]',
					isError
						? 'border-[var(--oxblood)] hover:border-[var(--oxblood)]'
						: 'border-[var(--rule)] hover:border-[var(--kola-amber)]'
				)}
				aria-expanded={open}
			>
				<span aria-hidden className="shrink-0 text-[8px] leading-none text-[var(--kola-amber)]">
					◾
				</span>
				<span className="truncate font-mono text-[11px] tracking-[0.04em] text-foreground">
					{title}
				</span>
				<span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-[var(--chip-carve)]">
					<StatusHint isError={isError} isPending={isPending} />
					{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
				</span>
			</button>
			{open && (
				<div className="border-l-2 border-[var(--kola-amber)] pl-3">
					<div className="max-h-[320px] overflow-auto pr-1">
						<ToolRendererDispatch pair={pair} threadId={threadId} density="full" />
					</div>
					<div className="mt-1 flex justify-end">
						<button
							type="button"
							onClick={handleOpenInViewer}
							className="inline-flex items-center gap-1 rounded-sm border border-[var(--rule)] bg-transparent px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--chip-carve)] transition-colors hover:border-[var(--kola-amber)] hover:text-[var(--kola-amber)]"
							title="Open this tool result in the viewer pane (phase 2)"
						>
							open in viewer
							<ExternalLink className="h-3 w-3" />
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

function StatusHint({ isError, isPending }: { isError: boolean; isPending: boolean }) {
	if (isError) {
		return (
			<span className="inline-flex items-center gap-1 text-[var(--oxblood)]">
				<CircleAlert className="h-3 w-3" />
				error
			</span>
		);
	}
	if (isPending) {
		return (
			<span className="inline-flex items-center gap-1 text-[var(--ember)]">
				<Loader2 className="h-3 w-3 animate-spin" />
				running
			</span>
		);
	}
	return <span>done</span>;
}

function deriveTitle(pair: PairedToolCall): string {
	const name = pair.use.name;
	const input = (pair.use.input ?? {}) as Record<string, unknown>;

	if (name === 'Bash') {
		const cmd = typeof input.command === 'string' ? input.command : '';
		return cmd ? `Bash: ${truncate(cmd, 80)}` : 'Bash';
	}
	if (name === 'Read') {
		const p = typeof input.file_path === 'string' ? input.file_path : '';
		return p ? `Read: ${shortenPath(p)}` : 'Read';
	}
	if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
		const p = typeof input.file_path === 'string' ? input.file_path : '';
		return p ? `${name}: ${shortenPath(p)}` : name;
	}
	if (name === 'Task') {
		const desc = typeof input.description === 'string' ? input.description : '';
		return desc ? `Task: ${truncate(desc, 80)}` : 'Task';
	}
	return name;
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function shortenPath(p: string): string {
	// Show last two segments for compactness.
	const parts = p.split('/');
	if (parts.length <= 2) return p;
	return '…/' + parts.slice(-2).join('/');
}

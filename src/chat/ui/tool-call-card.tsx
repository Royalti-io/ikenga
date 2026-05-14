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
import type { PairedToolCall } from '../store';
import { ReadRenderer } from './tool-renderers/read';
import { WriteEditRenderer } from './tool-renderers/write-edit';
import { BashRenderer } from './tool-renderers/bash';
import { TaskRenderer } from './tool-renderers/task';
import { GenericJsonRenderer } from './tool-renderers/generic-json';
import { AskUserQuestionRenderer } from './tool-renderers/ask-user-question';

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

	if (isChild) {
		// Children render at full density without pill chrome — they sit
		// inside the parent Task's expanded panel and already inherit its
		// scroll cap.
		return <Renderer pair={pair} threadId={threadId} density="full" />;
	}

	function handleOpenInViewer() {
		// Phase 1: viewer pane tab kind (`tool-output`) lands in phase 2.
		// Logging a warn so devs can grep for unwired CTAs.
		console.warn(
			'[tool-call-card] Open in viewer ↗ — not yet wired (ADR-011 phase 2)',
			pair.use.id
		);
	}

	return (
		<div className="space-y-2">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className={cn(
					'group flex w-full items-center gap-2 border border-[var(--rule)] bg-transparent px-2.5 py-1 text-left transition-colors hover:bg-[var(--rule-soft)]',
					isError
						? 'border-l-2 border-l-[var(--oxblood)] hover:border-l-[var(--oxblood)]'
						: 'hover:border-[var(--kola-amber)]'
				)}
				aria-expanded={open}
			>
				<span aria-hidden className="shrink-0 text-[8px] leading-none text-[var(--kola-amber)]">
					◾
				</span>
				<span className="truncate font-mono text-[11px] text-foreground">{title}</span>
				<span className="ml-auto inline-flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-[var(--chip-carve)]">
					<StatusHint isError={isError} isPending={isPending} />
					{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
				</span>
			</button>
			{open && (
				<div className="border-l-2 border-[var(--kola-amber)] pl-3">
					<div className="max-h-[320px] overflow-auto pr-1">
						<Renderer pair={pair} threadId={threadId} density="full" />
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

function Renderer({
	pair,
	threadId,
	density,
}: {
	pair: PairedToolCall;
	threadId: string;
	density: 'inline' | 'full';
}) {
	const name = pair.use.name;
	if (name === 'Read') return <ReadRenderer pair={pair} density={density} />;
	if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit')
		return <WriteEditRenderer pair={pair} density={density} />;
	if (name === 'Bash') return <BashRenderer pair={pair} density={density} />;
	if (name === 'Task') return <TaskRenderer pair={pair} density={density} threadId={threadId} />;
	// AskUserQuestion may be invoked under several names depending on how it's
	// registered (built-in, mcp scoped). Match on the trailing token.
	if (name === 'AskUserQuestion' || name.endsWith('AskUserQuestion')) {
		return <AskUserQuestionRenderer pair={pair} threadId={threadId} />;
	}
	return <GenericJsonRenderer pair={pair} density={density} />;
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

/**
 * Renderer for Anthropic's built-in `AskUserQuestion` tool.
 *
 * Phase 4 of the ACP migration moved the canonical flow to a real
 * permission round-trip (claude spawned with
 * `--permission-prompt-tool stdio`, the ACP server forwards as
 * `session/request_permission`, and the answer is replied with
 * `{ behavior: 'allow', updatedInput: { answers } }`). The Phase 4
 * `PermissionDialog` is the production UI for that path.
 *
 * Phase 11 retired the legacy auto-error / follow-up-message workaround
 * that lived here. This renderer is still reachable from the legacy
 * `claude-cli` adapter (opt-out flag `ikenga_chat_engine=legacy`) — in
 * that mode it renders the question read-only with a "switch to ACP for
 * a full answer flow" hint. On the ACP path the tool call never reaches
 * this renderer because permission round-trips don't surface as
 * `tool_use` events; the `PermissionDialog` overlays the request before
 * any tool event is emitted.
 *
 * Shape captured 2026-05-11 against Claude Code (the tool is invoked as
 * `mcp__anthropic__AskUserQuestion` or the unscoped `AskUserQuestion`):
 *
 *   input.questions: Array<{
 *     question: string,
 *     header: string,
 *     multiSelect: boolean,
 *     options: Array<{ label: string, description?: string, preview?: string }>,
 *   }>
 */

import { Info } from 'lucide-react';
import { Markdown } from '@/components/markdown';
import type { PairedToolCall } from '../../store';

interface AskUserQuestionInput {
	questions: AskUserQuestionEntry[];
}

interface AskUserQuestionEntry {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options: AskUserQuestionOption[];
}

interface AskUserQuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

interface AskUserQuestionRendererProps {
	pair: PairedToolCall;
	// threadId retained for API parity with other renderers; the active path
	// (ACP) handles AskUserQuestion via PermissionDialog, not this renderer.
	threadId: string;
}

export function AskUserQuestionRenderer({ pair }: AskUserQuestionRendererProps) {
	const input = (pair.use.input ?? {}) as Partial<AskUserQuestionInput>;
	const questions = input.questions ?? [];

	if (questions.length === 0) {
		return (
			<div className="text-xs text-muted-foreground">AskUserQuestion called with no questions.</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex items-start gap-2 border border-[var(--rule)] bg-transparent p-2 font-mono text-[10px] uppercase tracking-wider text-[var(--chip-carve)]">
				<Info className="mt-0.5 h-3 w-3 shrink-0 text-[var(--kola-amber)]" />
				<div className="normal-case tracking-normal">
					AskUserQuestion is handled via the ACP permission dialog on the default chat engine. This
					read-only view appears only on the legacy CLI path.
				</div>
			</div>
			{questions.map((q, i) => (
				<ReadOnlyQuestion key={`q-${i}`} q={q} />
			))}
		</div>
	);
}

function ReadOnlyQuestion({ q }: { q: AskUserQuestionEntry }) {
	return (
		<div className="space-y-2 border border-[var(--rule)] bg-transparent p-3">
			<div className="flex items-baseline gap-2 border-b border-[var(--rule)] pb-1.5 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--chip-carve)]">
				{q.header && <span className="text-[var(--kola-amber)]">◾ {q.header}</span>}
				<span>·</span>
				<span>{q.multiSelect ? 'pick any' : 'pick one'}</span>
			</div>
			<div className="text-sm font-medium">
				<Markdown content={q.question} density="compact" />
			</div>
			<ul className="space-y-1.5 text-xs">
				{q.options.map((opt) => (
					<li
						key={opt.label}
						className="flex items-start gap-2 border-l-2 border-[var(--rule)] pl-2"
					>
						<span className="font-mono font-medium uppercase tracking-wider text-[10px] text-foreground">
							{opt.label}
						</span>
						{opt.description && <span className="text-[var(--chip-carve)]">{opt.description}</span>}
					</li>
				))}
			</ul>
		</div>
	);
}

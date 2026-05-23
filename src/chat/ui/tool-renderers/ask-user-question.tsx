/**
 * Renderer for Anthropic's built-in `AskUserQuestion` tool.
 *
 * Two ways AskUserQuestion reaches the user on the Claude Code engine:
 *
 *   1. As an ACP permission round-trip — when claude (spawned with
 *      `--permission-prompt-tool stdio`) routes it through the prompt tool.
 *      The `PermissionDialog` overlay handles that path; this renderer is
 *      never reached for it (permission round-trips don't surface as
 *      `tool_use` events).
 *
 *   2. As a plain `tool_use` — when the permission prompt is bypassed for
 *      the turn (e.g. `--permission-mode bypassPermissions`). claude emits
 *      AskUserQuestion as an ordinary tool call and waits for the harness to
 *      send a `tool_result`. THIS renderer owns that path: it shows the same
 *      interactive form as the overlay and ferries the answer back via
 *      `sessionToolResult`, unblocking the turn.
 *
 * Because the answering `tool_result` is written to claude's stdin (not
 * re-emitted on its output stream), `pair.result` stays null after we
 * answer — so we track submission in local state to flip to the read-only
 * summary and prevent a double-submit.
 *
 * Shape captured 2026-05-11 (the tool is invoked as
 * `mcp__anthropic__AskUserQuestion` or the unscoped `AskUserQuestion`):
 *
 *   input.questions: Array<{
 *     question: string,
 *     header: string,
 *     multiSelect: boolean,
 *     options: Array<{ label: string, description?: string, preview?: string }>,
 *   }>
 */

import { CheckCircle2 } from 'lucide-react';
import { sessionToolResult } from '@/lib/tauri-cmd';
import type { PairedToolCall } from '../../store';
import { AskUserQuestionPrompt, type AskQuestion } from '../ask-user-question-form';
import { useAskAnswerStore } from '../ask-answer-store';

interface AskUserQuestionInput {
	questions: AskQuestion[];
}

interface AskUserQuestionRendererProps {
	pair: PairedToolCall;
	threadId: string;
}

export function AskUserQuestionRenderer({ pair, threadId }: AskUserQuestionRendererProps) {
	const input = (pair.use.input ?? {}) as Partial<AskUserQuestionInput>;
	const questions = input.questions ?? [];

	// Resolution is keyed by tool_use id in a store, not local state: the
	// answering tool_result is never echoed back (so `pair.result` stays null),
	// and component state would reset on remount — resurfacing an already-
	// answered form and letting it submit a second tool_result. See
	// `ask-answer-store`.
	const toolUseId = pair.use.id;
	const resolution = useAskAnswerStore((s) => s.resolved[toolUseId]);
	const markAnswered = useAskAnswerStore((s) => s.markAnswered);
	const markCancelled = useAskAnswerStore((s) => s.markCancelled);
	const clear = useAskAnswerStore((s) => s.clear);

	if (questions.length === 0) {
		return (
			<div className="text-xs text-muted-foreground">AskUserQuestion called with no questions.</div>
		);
	}

	// Already resolved — we answered/cancelled it (persisted in the store), or
	// defensively a paired tool_result arrived. Show a compact summary instead
	// of a re-submittable form.
	const isResolved = resolution != null || pair.result != null;
	if (isResolved) {
		return (
			<AnsweredSummary
				questions={questions}
				answers={resolution?.answers ?? null}
				cancelled={resolution?.cancelled ?? false}
			/>
		);
	}

	async function handleSubmit(answers: Record<string, string | string[]>) {
		// Optimistically flip to the answered state so the form can't be
		// re-submitted while the round-trip is in flight.
		markAnswered(toolUseId, answers);
		try {
			await sessionToolResult(threadId, toolUseId, { answers: flattenAnswers(answers) });
		} catch {
			// Revert on failure so the user can retry.
			clear(toolUseId);
		}
	}

	async function handleCancel() {
		markCancelled(toolUseId);
		try {
			await sessionToolResult(
				threadId,
				toolUseId,
				'The user cancelled the question without answering.',
				true
			);
		} catch {
			clear(toolUseId);
		}
	}

	return (
		<AskUserQuestionPrompt questions={questions} onSubmit={handleSubmit} onCancel={handleCancel} />
	);
}

/** Flatten the form's `string | string[]` answers into the comma-joined
 *  string shape claude's AskUserQuestion contract expects (mirrors the
 *  permission path's `ask_user_question_allow_body_from_meta`). */
function flattenAnswers(answers: Record<string, string | string[]>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [q, v] of Object.entries(answers)) {
		out[q] = Array.isArray(v) ? v.join(', ') : v;
	}
	return out;
}

function AnsweredSummary({
	questions,
	answers,
	cancelled,
}: {
	questions: AskQuestion[];
	answers: Record<string, string | string[]> | null;
	cancelled: boolean;
}) {
	if (cancelled) {
		return (
			<div className="flex items-center gap-2 border border-[var(--rule)] bg-transparent p-3 font-mono text-[10px] uppercase tracking-wider text-[var(--chip-carve)]">
				cancelled — no answer sent
			</div>
		);
	}
	const flat = answers ? flattenAnswers(answers) : {};
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--kola-amber)]">
				<CheckCircle2 className="h-3 w-3" />
				answered
			</div>
			<ul className="space-y-2">
				{questions.map((q) => (
					<li
						key={`${q.header ?? ''}::${q.question}`}
						className="border border-[var(--rule)] bg-transparent p-3"
					>
						<div className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--chip-carve)]">
							{q.header ? `◾ ${q.header}` : (q.question ?? 'question')}
						</div>
						<div className="mt-1 text-[13px] text-foreground">{flat[q.question] || '—'}</div>
					</li>
				))}
			</ul>
		</div>
	);
}

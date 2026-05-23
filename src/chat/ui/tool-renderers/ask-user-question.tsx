/**
 * Renderer for Anthropic's built-in `AskUserQuestion` tool.
 *
 * On the Claude Code engine, AskUserQuestion ALWAYS reaches the user as a
 * permission round-trip: claude (spawned with `--permission-prompt-tool
 * stdio`) emits a `control_request`/`can_use_tool` and blocks waiting for a
 * `control_response` — verified against claude 2.1.150 in default AND
 * bypassPermissions modes. (It does NOT come as a plain `tool_use` awaiting a
 * `tool_result`; an earlier build of this renderer answered via
 * `sessionToolResult`, which writes the wrong channel and hangs the turn.)
 *
 * The `PermissionDialog` overlay (anchored above the composer) is therefore
 * the SOLE answer surface. claude also emits the `tool_use` block, which is
 * what mounts this renderer — but it is **read-only**: it previews the
 * questions while pending and shows the answered summary once the dialog
 * resolves. The dialog stamps the shared `ask-answer-store` (keyed by
 * `tool_use` id) on submit/cancel; claude never echoes a `tool_result` for
 * AskUserQuestion, so that store is the only signal this card has.
 *
 * Shape captured 2026-05-11 (invoked as `mcp__anthropic__AskUserQuestion` or
 * the unscoped `AskUserQuestion`):
 *
 *   input.questions: Array<{
 *     question: string,
 *     header: string,
 *     multiSelect: boolean,
 *     options: Array<{ label: string, description?: string, preview?: string }>,
 *   }>
 */

import { CheckCircle2 } from 'lucide-react';
import type { PairedToolCall } from '../../store';
import { useAskAnswerStore } from '../ask-answer-store';
import type { AskQuestion } from '../ask-user-question-form';

interface AskUserQuestionInput {
	questions: AskQuestion[];
}

interface AskUserQuestionRendererProps {
	pair: PairedToolCall;
	/** Kept for the renderer-dispatch signature; AskUserQuestion answers flow
	 *  through the permission round-trip, not a per-thread tool_result. */
	threadId: string;
}

export function AskUserQuestionRenderer({ pair }: AskUserQuestionRendererProps) {
	const input = (pair.use.input ?? {}) as Partial<AskUserQuestionInput>;
	const questions = input.questions ?? [];

	// Resolution is keyed by tool_use id in a store (stamped by the
	// PermissionDialog), not local state: claude never echoes the answer back
	// on its output stream (so `pair.result` stays null), and component state
	// would reset on remount. See `ask-answer-store`.
	const toolUseId = pair.use.id;
	const resolution = useAskAnswerStore((s) => s.resolved[toolUseId]);

	if (questions.length === 0) {
		return (
			<div className="text-xs text-muted-foreground">AskUserQuestion called with no questions.</div>
		);
	}

	// Resolved — answered/cancelled via the dialog (persisted in the store), or
	// defensively a paired tool_result arrived. Show a compact summary.
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

	// Pending: just a breadcrumb. The PermissionDialog (rendered directly below
	// the thread) is the answer surface and already shows the full question +
	// options — repeating them here renders the question twice. Answering in
	// this card would also write the wrong wire channel.
	return <PendingPreview />;
}

/** Compact breadcrumb while the PermissionDialog awaits an answer. Deliberately
 *  does NOT repeat the question/options — the dialog below owns that, and
 *  duplicating it reads as a double render. */
function PendingPreview() {
	return (
		<div className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--chip-carve)]">
			awaiting your answer below ↓
		</div>
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

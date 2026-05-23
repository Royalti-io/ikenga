/**
 * Live ACP `session/request_permission` UI. Subscribes via
 * `chatListenRequests(threadId)`, renders the current request as an
 * inline ritual-styled prompt (anchored at the bottom of the thread,
 * above the composer), and replies via `chatRespondPermission`.
 *
 * Two flavours supported today:
 *   - AskUserQuestion — options encoded as `ask:{q_idx}:{label}`.
 *     Grouped per-question with the question text from `toolCall.rawInput`.
 *   - Generic tool permission — flat option list rendered with the
 *     four canonical kinds (`allow_once / allow_always / reject_once /
 *     reject_always`). Cancel maps to `cancelled` outcome.
 *
 * The component renders nothing when no request is pending; it is
 * safe to mount unconditionally inside `Thread`.
 */

import { Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/components/ui/utils';
import {
	type AcpPermissionOption,
	type AcpRequestEnvelope,
	chatListenRequests,
	chatRespondPermission,
} from '@/lib/tauri-cmd';
import { useAskAnswerStore } from './ask-answer-store';
import { type AskQuestion, AskUserQuestionPrompt } from './ask-user-question-form';

interface PermissionDialogProps {
	threadId: string;
}

interface AskInput {
	questions?: AskQuestion[];
}

export function PermissionDialog({ threadId }: PermissionDialogProps) {
	const [active, setActive] = useState<AcpRequestEnvelope | null>(null);
	const markAnswered = useAskAnswerStore((s) => s.markAnswered);
	const markCancelled = useAskAnswerStore((s) => s.markCancelled);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void chatListenRequests(threadId, (env) => {
			if (cancelled) return;
			setActive(env);
		}).then((un) => {
			if (cancelled) un();
			else unlisten = un;
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [threadId]);

	if (!active) return null;

	const req = active.request;

	function handleSelect(optionId: string) {
		const requestId = active!.requestId;
		setActive(null);
		void chatRespondPermission(requestId, {
			outcome: { outcome: 'selected', optionId },
		});
	}

	/** AskUserQuestion submit: builds `_meta.answers` keyed by question
	 *  text. Rust's `outcome_to_response_body` short-circuits on this and
	 *  forwards directly into Claude's `updatedInput.answers`. The
	 *  canonical `optionId` is a synthetic stable id so ACP's singular
	 *  `Selected(...)` slot still has something to point at.
	 *
	 *  We also stamp the shared `ask-answer-store` keyed by `toolUseId` so
	 *  the inline AskUserQuestion tool-card (which is read-only — the dialog
	 *  is the sole answer surface) flips to its answered summary. Claude
	 *  never echoes a tool_result for AskUserQuestion, so this store is the
	 *  only signal the card has. */
	function handleAskSubmit(answers: Record<string, string | string[]>) {
		const requestId = active!.requestId;
		const toolUseId = active!.toolUseId;
		setActive(null);
		if (toolUseId) markAnswered(toolUseId, answers);
		void chatRespondPermission(requestId, {
			outcome: { outcome: 'selected', optionId: 'ask:submitted' },
			_meta: { answers },
		});
	}

	function handleCancel() {
		const requestId = active!.requestId;
		const toolUseId = active!.toolUseId;
		setActive(null);
		if (toolUseId) markCancelled(toolUseId);
		void chatRespondPermission(requestId, {
			outcome: { outcome: 'cancelled' },
		});
	}

	const isAskUserQuestion = req.options.every(
		(o) => o.optionId.startsWith('ask:') || o.optionId === 'reject_once'
	);
	const rawInput = (req.toolCall.rawInput ?? {}) as AskInput;

	return (
		<div className="border-t-2 border-[var(--kola-amber)] bg-background">
			{isAskUserQuestion ? (
				<AskUserQuestionPrompt
					questions={rawInput.questions ?? []}
					onSubmit={handleAskSubmit}
					onCancel={handleCancel}
				/>
			) : (
				<GenericPermissionPrompt
					toolTitle={req.toolCall.title}
					toolName={req.toolCall.kind}
					options={req.options}
					onSelect={handleSelect}
					onCancel={handleCancel}
				/>
			)}
		</div>
	);
}

function GenericPermissionPrompt({
	toolTitle,
	toolName,
	options,
	onSelect,
	onCancel,
}: {
	toolTitle?: string;
	toolName?: string;
	options: AcpPermissionOption[];
	onSelect: (optionId: string) => void;
	onCancel: () => void;
}) {
	const KIND_LABEL: Record<string, string> = {
		allow_once: 'allow once',
		allow_always: 'allow always',
		reject_once: 'reject',
		reject_always: 'reject always',
	};
	const KIND_TONE: Record<string, 'amber' | 'oxblood'> = {
		allow_once: 'amber',
		allow_always: 'amber',
		reject_once: 'oxblood',
		reject_always: 'oxblood',
	};

	return (
		<div className="space-y-3 px-4 py-3">
			<div className="flex items-start justify-between gap-2">
				<div className="flex min-w-0 items-start gap-2 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--kola-amber)]">
					<Info className="mt-0.5 h-3 w-3 shrink-0" />
					<div className="min-w-0">
						<div>permission required</div>
						{(toolTitle || toolName) && (
							<div className="mt-1 truncate normal-case tracking-normal text-foreground">
								{toolTitle ?? toolName}
							</div>
						)}
					</div>
				</div>
				<button
					type="button"
					onClick={onCancel}
					className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-[var(--rule)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--chip-carve)] transition-colors hover:border-[var(--oxblood)] hover:text-[var(--oxblood)]"
					aria-label="Cancel permission request"
				>
					<X className="h-3 w-3" />
					cancel
				</button>
			</div>
			<div className="flex flex-wrap gap-2">
				{options.map((opt) => {
					const label = KIND_LABEL[opt.kind] ?? opt.name;
					const tone = KIND_TONE[opt.kind] ?? 'amber';
					return (
						<button
							key={opt.optionId}
							type="button"
							onClick={() => onSelect(opt.optionId)}
							className={cn(
								'inline-flex items-center gap-2 border border-[var(--rule)] bg-transparent px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-foreground transition-colors',
								tone === 'amber' &&
									'hover:border-[var(--kola-amber)] hover:bg-[var(--rule-soft)] hover:text-[var(--kola-amber)]',
								tone === 'oxblood' &&
									'hover:border-[var(--oxblood)] hover:bg-[var(--rule-soft)] hover:text-[var(--oxblood)]'
							)}
						>
							{label}
						</button>
					);
				})}
			</div>
		</div>
	);
}

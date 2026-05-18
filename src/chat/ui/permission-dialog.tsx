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

import { useEffect, useState } from 'react';
import { Info, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { Markdown } from '@/components/markdown';
import {
	chatListenRequests,
	chatRespondPermission,
	type AcpPermissionOption,
	type AcpRequestEnvelope,
} from '@/lib/tauri-cmd';

interface PermissionDialogProps {
	threadId: string;
}

interface AskOption {
	label: string;
	description?: string;
	preview?: string;
}

interface AskQuestion {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options?: AskOption[];
}

interface AskInput {
	questions?: AskQuestion[];
}

/** Sentinel label that surfaces as a free-text textarea per question.
 *  The user's typed value is sent as the answer string instead of the
 *  label itself. */
const OTHER_SENTINEL = '__other__';

export function PermissionDialog({ threadId }: PermissionDialogProps) {
	const [active, setActive] = useState<AcpRequestEnvelope | null>(null);

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
	 *  `Selected(...)` slot still has something to point at. */
	function handleAskSubmit(answers: Record<string, string | string[]>) {
		const requestId = active!.requestId;
		setActive(null);
		void chatRespondPermission(requestId, {
			outcome: { outcome: 'selected', optionId: 'ask:submitted' },
			_meta: { answers },
		});
	}

	function handleCancel() {
		const requestId = active!.requestId;
		setActive(null);
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

function AskUserQuestionPrompt({
	questions,
	onSubmit,
	onCancel,
}: {
	questions: AskQuestion[];
	onSubmit: (answers: Record<string, string | string[]>) => void;
	onCancel: () => void;
}) {
	// Per-question selection state. Single-select stores the chosen label
	// (or `__other__`); multi-select stores a Set of labels. Free-text
	// values for "Other" are kept separately so the same component can
	// toggle Other on/off without losing what the user typed.
	const [singleSel, setSingleSel] = useState<Record<number, string>>({});
	const [multiSel, setMultiSel] = useState<Record<number, Set<string>>>({});
	const [otherText, setOtherText] = useState<Record<number, string>>({});
	const [previewIdx, setPreviewIdx] = useState<{ q: number; label: string } | null>(null);

	function isMulti(q: AskQuestion): boolean {
		return !!q.multiSelect;
	}

	function pickSingle(qIdx: number, label: string) {
		setSingleSel((prev) => ({ ...prev, [qIdx]: label }));
	}

	function toggleMulti(qIdx: number, label: string) {
		setMultiSel((prev) => {
			const next = new Set(prev[qIdx] ?? new Set<string>());
			if (next.has(label)) next.delete(label);
			else next.add(label);
			return { ...prev, [qIdx]: next };
		});
	}

	function isSelected(qIdx: number, label: string, q: AskQuestion): boolean {
		if (isMulti(q)) return multiSel[qIdx]?.has(label) ?? false;
		return singleSel[qIdx] === label;
	}

	/** True when every question has at least one selection (or a non-empty
	 *  Other text when Other is the chosen option). Drives the submit
	 *  button's disabled state. */
	const allAnswered = questions.every((q, qIdx) => {
		if (isMulti(q)) {
			const set = multiSel[qIdx];
			if (!set || set.size === 0) return false;
			if (set.has(OTHER_SENTINEL) && !(otherText[qIdx]?.trim() ?? '')) return false;
			return true;
		}
		const sel = singleSel[qIdx];
		if (!sel) return false;
		if (sel === OTHER_SENTINEL && !(otherText[qIdx]?.trim() ?? '')) return false;
		return true;
	});

	function handleSubmit() {
		const answers: Record<string, string | string[]> = {};
		for (let qIdx = 0; qIdx < questions.length; qIdx++) {
			const q = questions[qIdx];
			if (!q) continue;
			const resolveLabel = (label: string): string =>
				label === OTHER_SENTINEL ? (otherText[qIdx]?.trim() ?? '') : label;
			if (isMulti(q)) {
				const set = multiSel[qIdx];
				const vals = Array.from(set ?? [])
					.map(resolveLabel)
					.filter((s) => s.length > 0);
				answers[q.question] = vals;
			} else {
				const sel = singleSel[qIdx];
				answers[q.question] = sel ? resolveLabel(sel) : '';
			}
		}
		onSubmit(answers);
	}

	// Active preview lookup. The preview panel renders to the right of
	// the options on wide screens and below on narrow.
	const activePreview =
		previewIdx != null
			? (questions[previewIdx.q]?.options ?? []).find((o) => o.label === previewIdx.label)?.preview
			: null;

	return (
		<div className="space-y-3 px-4 py-3">
			<div className="flex items-center justify-between gap-2 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--kola-amber)]">
				<span className="inline-flex items-center gap-2">
					<span>◾</span>
					<span>ask user · pending</span>
				</span>
				<button
					type="button"
					onClick={onCancel}
					className="inline-flex items-center gap-1 rounded-sm border border-[var(--rule)] px-1.5 py-0.5 text-[var(--chip-carve)] transition-colors hover:border-[var(--oxblood)] hover:text-[var(--oxblood)]"
					aria-label="Cancel question"
					title="Cancel — claude receives a cancellation outcome"
				>
					<X className="h-3 w-3" />
					cancel
				</button>
			</div>
			<div className={cn('grid gap-3', activePreview ? 'lg:grid-cols-[1fr_1fr]' : 'grid-cols-1')}>
				<div className="space-y-3">
					{questions.map((q, qIdx) => {
						const multi = isMulti(q);
						const opts = q.options ?? [];
						return (
							<div key={qIdx} className="space-y-2 border border-[var(--rule)] bg-transparent p-3">
								<div className="flex items-baseline gap-2 border-b border-[var(--rule)] pb-1.5 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--chip-carve)]">
									{q.header && <span className="text-[var(--kola-amber)]">◾ {q.header}</span>}
									{q.header && <span>·</span>}
									<span>{multi ? 'pick any' : 'pick one'}</span>
								</div>
								{q.question && (
									<div className="text-sm font-medium">
										<Markdown content={q.question} density="compact" />
									</div>
								)}
								<ul className="space-y-1.5">
									{opts.map((opt) => {
										const sel = isSelected(qIdx, opt.label, q);
										const hasPreview = !!opt.preview;
										return (
											<li key={opt.label}>
												<button
													type="button"
													onClick={() =>
														multi ? toggleMulti(qIdx, opt.label) : pickSingle(qIdx, opt.label)
													}
													onMouseEnter={() =>
														hasPreview && setPreviewIdx({ q: qIdx, label: opt.label })
													}
													onFocus={() => hasPreview && setPreviewIdx({ q: qIdx, label: opt.label })}
													className={cn(
														'group/opt flex w-full items-start gap-2 border bg-transparent px-2 py-1.5 text-left transition-colors',
														sel
															? 'border-[var(--kola-amber)] bg-[var(--rule-soft)]'
															: 'border-[var(--rule)] hover:border-[var(--kola-amber)] hover:bg-[var(--rule-soft)]'
													)}
												>
													<span
														className={cn(
															'mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center border',
															multi ? 'rounded-sm' : 'rounded-full',
															sel
																? 'border-[var(--kola-amber)] bg-[var(--kola-amber)]'
																: 'border-[var(--rule)]'
														)}
													>
														{sel && multi && (
															<span className="text-[10px] leading-none text-background">✓</span>
														)}
													</span>
													<span className="flex-1 space-y-0.5">
														<span className="block text-[13px] font-medium text-foreground">
															{opt.label}
														</span>
														{opt.description && (
															<span className="block text-[11px] leading-relaxed text-muted-foreground">
																{opt.description}
															</span>
														)}
													</span>
													{hasPreview && (
														<span className="font-mono text-[9px] uppercase tracking-wider text-[var(--chip-carve)]">
															preview
														</span>
													)}
												</button>
											</li>
										);
									})}
									{/* Always-present free-text fallback. The textarea
									    enables when Other is selected; submit checks for
									    non-empty trimmed text. */}
									<li>
										<button
											type="button"
											onClick={() =>
												multi ? toggleMulti(qIdx, OTHER_SENTINEL) : pickSingle(qIdx, OTHER_SENTINEL)
											}
											className={cn(
												'flex w-full items-start gap-2 border bg-transparent px-2 py-1.5 text-left transition-colors',
												isSelected(qIdx, OTHER_SENTINEL, q)
													? 'border-[var(--kola-amber)] bg-[var(--rule-soft)]'
													: 'border-dashed border-[var(--rule)] hover:border-[var(--kola-amber)]'
											)}
										>
											<span
												className={cn(
													'mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center border',
													multi ? 'rounded-sm' : 'rounded-full',
													isSelected(qIdx, OTHER_SENTINEL, q)
														? 'border-[var(--kola-amber)] bg-[var(--kola-amber)]'
														: 'border-[var(--rule)]'
												)}
											/>
											<span className="flex-1 text-[13px] font-medium text-muted-foreground">
												Other (free text)
											</span>
										</button>
										{isSelected(qIdx, OTHER_SENTINEL, q) && (
											<textarea
												value={otherText[qIdx] ?? ''}
												onChange={(e) =>
													setOtherText((prev) => ({ ...prev, [qIdx]: e.target.value }))
												}
												placeholder="Type your answer…"
												rows={2}
												className="mt-1 block w-full resize-none rounded-sm border border-[var(--rule)] bg-background px-2 py-1 text-sm font-mono"
											/>
										)}
									</li>
								</ul>
							</div>
						);
					})}
					<div className="flex justify-end">
						<button
							type="button"
							onClick={handleSubmit}
							disabled={!allAnswered}
							className={cn(
								'inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors',
								allAnswered
									? 'border-[var(--kola-amber)] bg-[var(--kola-amber)] text-background hover:bg-[var(--kola-amber-soft)]'
									: 'cursor-not-allowed border-[var(--rule)] text-muted-foreground'
							)}
						>
							Submit answers
						</button>
					</div>
				</div>
				{activePreview && (
					<div className="rounded-sm border border-[var(--rule)] bg-[var(--rule-soft)] p-3">
						<div className="mb-2 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--chip-carve)]">
							preview
						</div>
						<pre className="overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground">
							{activePreview}
						</pre>
					</div>
				)}
			</div>
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

/**
 * Shared interactive `AskUserQuestion` form.
 *
 * Two callers, two arrival shapes, one UI:
 *   - `PermissionDialog` (overlay) — when claude routes AskUserQuestion
 *     through `--permission-prompt-tool stdio` as an `sdk_control_request`.
 *     Submits via `chatRespondPermission` with `_meta.answers`.
 *   - The inline tool renderer (`tool-renderers/ask-user-question.tsx`) —
 *     when the permission prompt is bypassed and AskUserQuestion arrives as
 *     a plain `tool_use`. Submits via `sessionToolResult`.
 *
 * The component is callback-agnostic: it owns selection state and hands the
 * caller a `{ [questionText]: string | string[] }` map on submit. Single-
 * select stores the chosen label (or `__other__`); multi-select stores a Set
 * of labels. Free-text values for "Other" are kept separately so toggling
 * Other on/off doesn't lose what the user typed.
 */

import { useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { Markdown } from '@/components/markdown';

export interface AskOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface AskQuestion {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options?: AskOption[];
}

/** Sentinel label that surfaces as a free-text textarea per question.
 *  The user's typed value is sent as the answer string instead of the
 *  label itself. */
export const OTHER_SENTINEL = '__other__';

export function AskUserQuestionPrompt({
	questions,
	onSubmit,
	onCancel,
}: {
	questions: AskQuestion[];
	onSubmit: (answers: Record<string, string | string[]>) => void;
	onCancel: () => void;
}) {
	const [singleSel, setSingleSel] = useState<Record<number, string>>({});
	const [multiSel, setMultiSel] = useState<Record<number, Set<string>>>({});
	const [otherText, setOtherText] = useState<Record<number, string>>({});
	const [previewIdx, setPreviewIdx] = useState<{ q: number; label: string } | null>(null);
	// Stepper: one question per step with Back/Next. Single-question forms
	// skip the nav chrome and show Submit directly.
	const [step, setStep] = useState(0);

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

	/** True when the given question has at least one selection (or a non-empty
	 *  Other text when Other is the chosen option). Gates Next + Submit. */
	function isQuestionAnswered(qIdx: number): boolean {
		const q = questions[qIdx];
		if (!q) return false;
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
	}

	const allAnswered = questions.every((_q, qIdx) => isQuestionAnswered(qIdx));

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
					{questions.length > 1 && (
						<span className="text-[var(--chip-carve)]">
							· {step + 1} of {questions.length}
						</span>
					)}
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
						if (qIdx !== step) return null;
						const multi = isMulti(q);
						const opts = q.options ?? [];
						return (
							<div
								key={`${q.header ?? ''}::${q.question}`}
								className="space-y-2 border border-[var(--rule)] bg-transparent p-3"
							>
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
					<div className="flex items-center justify-between gap-2">
						{questions.length > 1 ? (
							<button
								type="button"
								onClick={() => setStep((s) => Math.max(0, s - 1))}
								disabled={step === 0}
								className={cn(
									'inline-flex items-center gap-1 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors',
									step === 0
										? 'cursor-not-allowed border-[var(--rule)] text-muted-foreground'
										: 'border-[var(--rule)] text-foreground hover:border-[var(--kola-amber)] hover:bg-[var(--rule-soft)]'
								)}
							>
								<ChevronLeft className="h-3 w-3" />
								Back
							</button>
						) : (
							<span />
						)}
						{step < questions.length - 1 ? (
							<button
								type="button"
								onClick={() => setStep((s) => Math.min(questions.length - 1, s + 1))}
								disabled={!isQuestionAnswered(step)}
								className={cn(
									'inline-flex items-center gap-1 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors',
									isQuestionAnswered(step)
										? 'border-[var(--kola-amber)] text-[var(--kola-amber)] hover:bg-[var(--rule-soft)]'
										: 'cursor-not-allowed border-[var(--rule)] text-muted-foreground'
								)}
							>
								Next
								<ChevronRight className="h-3 w-3" />
							</button>
						) : (
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
						)}
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

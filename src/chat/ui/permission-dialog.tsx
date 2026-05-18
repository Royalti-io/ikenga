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

interface AskQuestion {
	question: string;
	header?: string;
	multiSelect?: boolean;
}

interface AskInput {
	questions?: AskQuestion[];
}

/** Parse `ask:{q_idx}:{label}` → `{ qIdx, label }`. Returns `null` for
 *  options that don't match (e.g. the four canonical generic-permission
 *  kinds). */
function parseAskOptionId(optionId: string): { qIdx: number; label: string } | null {
	if (!optionId.startsWith('ask:')) return null;
	const rest = optionId.slice(4);
	const colon = rest.indexOf(':');
	if (colon === -1) return null;
	const qIdx = Number(rest.slice(0, colon));
	if (!Number.isFinite(qIdx)) return null;
	return { qIdx, label: rest.slice(colon + 1) };
}

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

	function handleCancel() {
		const requestId = active!.requestId;
		setActive(null);
		void chatRespondPermission(requestId, {
			outcome: { outcome: 'cancelled' },
		});
	}

	const isAskUserQuestion = req.options.every((o) => o.optionId.startsWith('ask:'));
	const rawInput = (req.toolCall.rawInput ?? {}) as AskInput;

	return (
		<div className="border-t-2 border-[var(--kola-amber)] bg-background">
			{isAskUserQuestion ? (
				<AskUserQuestionPrompt
					questions={rawInput.questions ?? []}
					options={req.options}
					onSelect={handleSelect}
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
	options,
	onSelect,
	onCancel,
}: {
	questions: AskQuestion[];
	options: AcpPermissionOption[];
	onSelect: (optionId: string) => void;
	onCancel: () => void;
}) {
	// Group options by question index. Options without an `ask:` prefix
	// fall into bucket `-1` and render under an unlabeled section.
	const groups = new Map<number, AcpPermissionOption[]>();
	for (const opt of options) {
		const parsed = parseAskOptionId(opt.optionId);
		const key = parsed?.qIdx ?? -1;
		const arr = groups.get(key) ?? [];
		arr.push(opt);
		groups.set(key, arr);
	}
	const sortedKeys = Array.from(groups.keys()).sort((a, b) => a - b);

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
			{sortedKeys.map((qIdx) => {
				const q = qIdx >= 0 ? questions[qIdx] : undefined;
				const opts = groups.get(qIdx) ?? [];
				return (
					<div key={qIdx} className="space-y-2 border border-[var(--rule)] bg-transparent p-3">
						<div className="flex items-baseline gap-2 border-b border-[var(--rule)] pb-1.5 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--chip-carve)]">
							{q?.header && <span className="text-[var(--kola-amber)]">◾ {q.header}</span>}
							{q?.header && <span>·</span>}
							<span>pick one</span>
						</div>
						{q?.question && (
							<div className="text-sm font-medium">
								<Markdown content={q.question} density="compact" />
							</div>
						)}
						<ul className="space-y-1.5">
							{opts.map((opt) => {
								const parsed = parseAskOptionId(opt.optionId);
								const label = parsed?.label ?? opt.name;
								return (
									<li key={opt.optionId}>
										<button
											type="button"
											onClick={() => onSelect(opt.optionId)}
											className={cn(
												'group/opt flex w-full items-start gap-2 border border-[var(--rule)] bg-transparent px-2 py-1.5 text-left transition-colors',
												'hover:border-[var(--kola-amber)] hover:bg-[var(--rule-soft)]'
											)}
										>
											<span className="mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--rule)] transition-colors group-hover/opt:border-[var(--kola-amber)]" />
											<span className="font-mono text-[11px] uppercase tracking-wider text-foreground">
												{label}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</div>
				);
			})}
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

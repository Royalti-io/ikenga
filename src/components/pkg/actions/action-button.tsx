// WP-13: one skill-action button.
//
// Dispatch-only lighthouse — only `uxMode === 'confirm'` actions are active.
// Clicking one seeds the action's `chat_prompt` into the active chat session
// via `sendToActiveSession` (the same shared core `host.sendToActiveSession`
// uses). Every other mode renders disabled with a small mode badge — a visible
// placeholder for the streaming / approve / setup flows landing in later WPs.

import { useState } from 'react';

import { sendToActiveSession } from '@/components/pkg/send-to-active-session';
import { cn } from '@/components/ui/utils';
import type { SkillAction } from '@/lib/tauri-cmd';

export function ActionButton({ action }: { action: SkillAction }) {
	const isConfirm = action.uxMode === 'confirm';
	const [pending, setPending] = useState(false);
	const [note, setNote] = useState<string | null>(null);

	async function dispatch() {
		if (pending) return;
		setPending(true);
		setNote(null);
		// Prefer the parsed run.prompt; fall back to a sensible instruction so
		// the button never seeds an empty turn.
		const prompt =
			action.promptTemplate?.trim() ||
			`${action.name}${action.description ? ` — ${action.description}` : ''}`;
		try {
			// Source-stamps the body as `[via: groundwork/skill-action]`.
			const res = await sendToActiveSession({ prompt, source: 'skill-action' });
			if (!res.ok) {
				// The only non-error refusal here is no focused chat pane;
				// surface it inline rather than throwing.
				setNote(
					res.reason === 'no-active-session' ? 'Open a chat pane first' : `Refused: ${res.reason}`
				);
			}
		} catch (e) {
			setNote(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(false);
		}
	}

	return (
		<button
			type="button"
			data-mode={action.uxMode}
			data-active={isConfirm ? 'true' : 'false'}
			disabled={!isConfirm || pending}
			title={
				isConfirm
					? (action.description ?? action.name)
					: `${action.name} — ${action.uxMode} mode not yet available`
			}
			onClick={isConfirm ? dispatch : undefined}
			className={cn(
				'inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-sm font-medium transition-colors',
				isConfirm
					? 'border-primary bg-primary text-primary-foreground hover:brightness-110'
					: 'border-border bg-card text-muted-foreground opacity-70',
				pending && 'opacity-60'
			)}
		>
			<span className="truncate">{action.name}</span>
			{!isConfirm && (
				<span className="rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
					{action.uxMode}
				</span>
			)}
			{note && <span className="ml-1 text-[10px] text-muted-foreground">({note})</span>}
		</button>
	);
}

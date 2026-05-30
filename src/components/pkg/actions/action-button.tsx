// WP-13: one skill-action button.
//
// Dispatch-only lighthouse — only `uxMode === 'confirm'` actions are active.
// Clicking one routes the action's `chat_prompt` through the shell's reusable
// New-Session dialog (`openSessionDialog`, the `host.openSessionDialog` verb's
// core). The dialog is the consent surface: it pre-fills an editable prompt
// (source-stamped `[via: groundwork/skill-action]`), lets the operator pick a
// target (Chat / Terminal / Agent) + engine, and on Start mints + focuses +
// seeds a *fresh* session by id.
//
// Why the dialog rather than `sendToActiveSession`: that core targets the
// *currently-focused* pane-store chat, but clicking this button (a native pane
// node) steals pane focus to the pkg pane first (pane.tsx `onMouseDownCapture`
// / the iyke click's `el.focus()`), so there is no focused chat at dispatch
// time. `sendToActiveSession` works only for iframe-isolated callers (artifact
// channel / pkg AppBridge) whose clicks never reach the pane focus-capture.
// The dialog sidesteps the steal entirely — it opens its own session and seeds
// by thread id, independent of pane focus. (Caught in WP-13 live-verify.)
//
// Every other mode renders disabled with a small mode badge — a visible
// placeholder for the streaming / approve / setup flows landing in later WPs.

import { useState } from 'react';

import { openSessionDialog } from '@/components/pkg/open-session-dialog';
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
		// the dialog never opens with an empty prompt.
		const prompt =
			action.promptTemplate?.trim() ||
			`${action.name}${action.description ? ` — ${action.description}` : ''}`;
		try {
			// Opens the reusable New-Session dialog pre-filled with the prompt;
			// the dialog source-stamps the body as `[via: groundwork/skill-action]`
			// and mints/seeds the chosen target on Start. Resolves on Start or
			// Cancel — neither is an error; a clean cancel just clears state.
			const res = await openSessionDialog({
				initialPrompt: prompt,
				source: 'skill-action',
				sessionKind: 'chat',
			});
			if (!res.ok && res.reason === 'scope-denied') {
				setNote('Scope denied');
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

// WP-13 · WP-18b: one skill-action button.
//
// Dispatch routes the action through the shell's reusable New-Session dialog
// (`openSessionDialog`, the `host.openSessionDialog` verb's core). The dialog is
// the consent surface: it pre-fills an editable prompt (source-stamped
// `[via: groundwork/<source>]`), lets the operator pick a target (Chat /
// Terminal / Agent) + engine, and on Start mints + focuses + seeds a *fresh*
// session by id.
//
// Dispatchable modes: `confirm` (seed → review → send) and `approve` (run →
// pause at the approve gate). WP-18b adds the well-known `setup` action: it
// ships `ux_mode: streaming` but is enabled by *name*, dispatching into the
// setup-chat flow (§1-§4). Every *other* streaming action stays disabled — a
// visible placeholder with a mode badge.
//
// Why the dialog rather than `sendToActiveSession`: that core targets the
// *currently-focused* pane-store chat, but clicking this button (a native pane
// node) steals pane focus to the pkg pane first, so there is no focused chat at
// dispatch time. The dialog opens its own session and seeds by thread id,
// independent of pane focus. (Caught in WP-13 live-verify.)

import { useState } from 'react';

import { cn } from '@/components/ui/utils';
import type { SkillAction } from '@/lib/tauri-cmd';
import { dispatchAction, isDispatchable, isSetupAction } from './action-runner';
import { setupButtonLabel, useSetupState } from './use-setup-state';

export function ActionButton({ action }: { action: SkillAction }) {
	const isConfirm = action.uxMode === 'confirm';
	const isApprove = action.uxMode === 'approve';
	const isSetup = isSetupAction(action);
	const canDispatch = isDispatchable(action);
	const setupState = useSetupState(action);
	const [pending, setPending] = useState(false);
	const [note, setNote] = useState<string | null>(null);

	// Setup's label reflects instance state (R14): fresh vs re-run vs migrate.
	const label = isSetup ? setupButtonLabel(setupState) : action.name;
	// Hold Alt (or Shift) when clicking Set up to force the interview flow
	// instead of the ai-infer default (§5). Ignored for non-setup actions.
	async function dispatch(interview: boolean) {
		if (pending) return;
		setPending(true);
		setNote(null);
		try {
			const res = await dispatchAction(action, { interview });
			if (!res.ok && res.reason === 'scope-denied') {
				setNote('Scope denied');
			}
		} catch (e) {
			setNote(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(false);
		}
	}

	const title = isSetup
		? `${label} — runs as a Chi conversation in the dock`
		: canDispatch
			? isApprove
				? `${action.name} — runs, then pauses at the approve gate`
				: (action.description ?? action.name)
			: `${action.name} — ${action.uxMode} mode not yet available`;

	return (
		<button
			type="button"
			data-mode={action.uxMode}
			data-setup={isSetup ? setupState.status : undefined}
			data-active={canDispatch ? 'true' : 'false'}
			disabled={!canDispatch || pending}
			title={title}
			onClick={canDispatch ? (e) => dispatch(e.altKey || e.shiftKey) : undefined}
			className={cn(
				'inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-sm font-medium transition-colors',
				canDispatch
					? 'border-primary bg-primary text-primary-foreground hover:brightness-110'
					: 'border-border bg-card text-muted-foreground opacity-70',
				pending && 'opacity-60'
			)}
		>
			<span className="truncate">{label}</span>
			{/* Non-setup streaming/silent/form placeholders keep their mode badge;
			    setup is enabled so it shows none. */}
			{!isConfirm && !isSetup && (
				<span className="rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
					{action.uxMode}
				</span>
			)}
			{note && <span className="ml-1 text-[10px] text-muted-foreground">({note})</span>}
		</button>
	);
}

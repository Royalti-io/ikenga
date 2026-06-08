// ActionRunner (WP-5) — central dispatch for skill-action `ux_mode`s.
//
// Today two modes dispatch:
//   • `confirm` — seeds a chat for the operator to review + send (consent BEFORE).
//   • `approve` — runs the action; its drafts pause at the approve gate
//     (/outbox/approvals) via the `pa-action-paused` event (consent AFTER, at
//     the gate). The producing run reaches the gate by calling the
//     `pa_actions.pause` tool (WP-8). See plans/atelier/10-approve-gate-seam.md.
//
// Both open the reusable New-Session dialog as the dispatch surface — the dialog
// is the prompt-injection mitigation (editable prompt) and sidesteps the pane
// focus-steal that breaks `sendToActiveSession` for native pane clicks. The
// `streaming` / `silent` / `form` modes land in later WPs.

import {
	type OpenSessionDialogResult,
	openSessionDialog,
} from '@/components/pkg/open-session-dialog';
import type { SkillAction } from '@/lib/tauri-cmd';

const DISPATCHABLE_UX_MODES = ['confirm', 'approve'] as const;

/** Whether the runner can dispatch this `ux_mode` today (button enabled). */
export function isDispatchable(uxMode: string): boolean {
	return (DISPATCHABLE_UX_MODES as readonly string[]).includes(uxMode);
}

/**
 * Dispatch a skill action. Builds the prompt from `run.prompt` (falling back to
 * name + description) and opens the New-Session dialog seeded with it. Resolves
 * on Start or Cancel — a clean cancel is not an error.
 */
export async function dispatchAction(action: SkillAction): Promise<OpenSessionDialogResult> {
	const prompt =
		action.promptTemplate?.trim() ||
		`${action.name}${action.description ? ` — ${action.description}` : ''}`;
	return openSessionDialog({
		initialPrompt: prompt,
		source: action.uxMode === 'approve' ? 'approve-action' : 'skill-action',
		sessionKind: 'chat',
	});
}

// ActionRunner (WP-5 · WP-18b) — central dispatch for skill-action `ux_mode`s.
//
// With the terminal surface removed, dispatch is a clean no-op stub. The
// skill-action button surface remains visible (with its mode badges / setup
// labels) while Chi agents move to the CLI/MCP invocation layer.

import type { SkillAction } from '@/lib/tauri-cmd';

/** Sunset result — the New-Session dialog is gone, so all dispatches fail with
 *  a clean `not-implemented` reason. */
export interface OpenSessionDialogResult {
	ok: boolean;
	reason?: 'scope-denied' | 'cancelled' | 'not-implemented';
}

const DISPATCHABLE_UX_MODES = ['confirm', 'approve'] as const;

/** The well-known `setup` action — the contract's `superRefine` gates the
 *  `setup` block on it, and `skill_actions.rs` derives `verb === name` from the
 *  same frontmatter `name` (else the file stem), so both equal `'setup'` for
 *  `<skill>/actions/setup.md`. Match either for robustness. */
export function isSetupAction(action: Pick<SkillAction, 'name' | 'verb'>): boolean {
	return action.name === 'setup' || action.verb === 'setup';
}

/** Whether the runner can dispatch this action today (button enabled).
 *  `setup` is dispatchable by name regardless of its `streaming` ux_mode;
 *  everything else falls back to the mode allow-list. */
export function isDispatchable(action: SkillAction): boolean {
	if (isSetupAction(action)) return true;
	return (DISPATCHABLE_UX_MODES as readonly string[]).includes(action.uxMode);
}

/** Options for a dispatch. `interview` was the setup flow modifier — retained
 *  in the signature so callers don't need to change, but ignored now that
 *  dispatch is a stub. */
export interface DispatchOptions {
	interview?: boolean;
}

/** Dispatch a skill action. With the terminal surface removed, this always resolves
 *  to a `not-implemented` result so callers can show a graceful placeholder. */
export async function dispatchAction(
	_action: SkillAction,
	_opts: DispatchOptions = {}
): Promise<OpenSessionDialogResult> {
	return { ok: false, reason: 'not-implemented' };
}

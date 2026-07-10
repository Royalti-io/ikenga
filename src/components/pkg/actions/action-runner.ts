// ActionRunner (WP-5 · WP-18b) — central dispatch for skill-action `ux_mode`s.
//
// Today three dispatch paths:
//   • `confirm` — seeds a chat for the operator to review + send (consent BEFORE).
//   • `approve` — runs the action; its drafts pause at the approve gate
//     (/outbox/approvals) via the `pa-action-paused` event (consent AFTER, at
//     the gate). The producing run reaches the gate by calling the
//     `pa_actions.pause` tool (WP-8). See plans/atelier/10-approve-gate-seam.md.
//   • `setup` — name-keyed, NOT mode-keyed (WP-18b R-04). The well-known
//     `setup` action ships `ux_mode: streaming` but dispatches into the
//     setup-chat flow regardless; every *other* streaming action stays disabled
//     (streaming GA is out of scope). See
//     plans/atelier-parity/designs/parity-setup-chat-impl.html §1-§4.
//
// All open the reusable New-Session dialog as the dispatch surface — the dialog
// is the prompt-injection mitigation (editable prompt) and sidesteps the pane
// focus-steal that breaks `sendToActiveSession` for native pane clicks. The
// remaining `streaming` (non-setup) / `silent` / `form` modes land in later WPs.

import {
	type OpenSessionDialogResult,
	openSessionDialog,
} from '@/components/pkg/open-session-dialog';
import type { SkillAction } from '@/lib/tauri-cmd';

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

/** Options for a dispatch. `interview` forces the setup flow into interview
 *  mode (walk `setup.interview_questions`) instead of the `ai_infer` default —
 *  bound to a modifier click on the ActionBar button (WP-18b §5). Ignored by
 *  non-setup dispatches. */
export interface DispatchOptions {
	interview?: boolean;
}

/**
 * Dispatch a skill action. `setup` routes into the setup-chat flow; every other
 * dispatchable mode builds the prompt from `promptTemplate` (falling back to
 * name + description) and opens the New-Session dialog seeded with it. Resolves
 * on Start or Cancel — a clean cancel is not an error.
 */
export async function dispatchAction(
	action: SkillAction,
	opts: DispatchOptions = {}
): Promise<OpenSessionDialogResult> {
	if (isSetupAction(action)) return dispatchSetup(action, opts.interview ?? false);
	const prompt =
		action.promptTemplate?.trim() ||
		`${action.name}${action.description ? ` — ${action.description}` : ''}`;
	return openSessionDialog({
		initialPrompt: prompt,
		source: action.uxMode === 'approve' ? 'approve-action' : 'skill-action',
		sessionKind: 'chat',
	});
}

/**
 * Seed a fresh dock chat with the setup prompt (WP-18b §3-§4). The prompt is
 * `promptTemplate` when the skill author supplied one, else synthesized from the
 * `setup` spec (mode + template_version + infer_sources / interview), and always
 * carries a stamped instance-path line so the agent knows the write target. The
 * New-Session dialog stamps `[via: groundwork/skill-setup]` and mints + seeds a
 * fresh thread by id (R3/R16) — the operator can edit the prompt before Start
 * (e.g. to switch ai-infer ↔ interview by hand).
 */
async function dispatchSetup(
	action: SkillAction,
	interview: boolean
): Promise<OpenSessionDialogResult> {
	const prompt = buildSetupPrompt(action, interview);
	const instanceLine = `Target instance file: .atelier/${action.skill}/manifest.json`;
	return openSessionDialog({
		initialPrompt: `${prompt}\n\n${instanceLine}`,
		source: 'skill-setup',
		sessionKind: 'chat',
	});
}

/** Build the setup seed prompt. Prefers the author's `promptTemplate`; otherwise
 *  synthesizes a mode-aware instruction from the `setup` spec. Exported for the
 *  unit test. */
export function buildSetupPrompt(action: SkillAction, interview: boolean): string {
	const template = action.promptTemplate?.trim();
	if (template) return template;

	const setup = action.setup;
	const mode = interview ? 'interview' : (setup?.mode ?? 'ai_infer');
	const templateVersion = setup?.templateVersion ?? 1;
	const lines = [
		`Run the \`setup\` action for ${action.skill} (mode: ${mode}, template_version: ${templateVersion}).`,
	];
	if (mode === 'interview') {
		lines.push(
			'Interview me with setup.interview_questions, draft the instance config from my',
			`answers, confirm each value with me in chat, then write .atelier/${action.skill}/manifest.json.`
		);
	} else {
		const sources =
			setup?.inferSources && setup.inferSources.length > 0
				? setup.inferSources.join(', ')
				: 'the project';
		lines.push(
			`Read infer_sources — ${sources} — draft the instance config, confirm each value`,
			`with me in chat, then write .atelier/${action.skill}/manifest.json.`
		);
	}
	return lines.join('\n');
}

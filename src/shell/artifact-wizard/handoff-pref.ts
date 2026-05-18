// Persisted preference for the wizard's terminal-handoff decision.
//
// `attach` — when the grid swaps to loupe, move the terminal into the
//            loupe's Chat tab body and close the right pane.
// `keep`   — leave the terminal sitting in the right pane.
// `ask`    — show a modal each time (default until the user picks).
//
// Settable from the prompt's "Remember my choice" checkbox or from
// Settings → Artifact grid.

import { settingsGet, settingsSet } from '@/lib/tauri-cmd';
import { type PendingHandoff, useHandoffStore } from '@/shell/artifact-wizard/handoff-store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useTerminalStore } from '@/terminal/session-store';

export type HandoffPref = 'attach' | 'keep' | 'ask';
const KEY = 'artifact-wizard.terminalHandoff';

export async function loadHandoffPref(): Promise<HandoffPref> {
	try {
		const raw = await settingsGet(KEY);
		if (raw === 'attach' || raw === 'keep' || raw === 'ask') return raw;
	} catch {
		// settings_kv read failed — fall through to default
	}
	return 'ask';
}

export async function saveHandoffPref(value: HandoffPref): Promise<void> {
	await settingsSet(KEY, value);
}

/** Apply `attach` or `keep` to a pending handoff. `attach` flips the
 *  terminal's owner to the studio pane, marks the loupe's
 *  `attachedTerminalId`, and closes the now-redundant right leaf. `keep`
 *  is a no-op (terminal stays in the right pane). */
export function applyHandoff(action: 'attach' | 'keep', h: PendingHandoff): void {
	if (action === 'keep') return;
	const ts = useTerminalStore.getState();
	const ps = usePaneStore.getState();
	const res = ts.attachToStudio(h.terminalSessionId, h.studioLeafId, h.artifactPath);
	if (!res.ok) {
		// Existing studio attachment on another pane — bail out and leave
		// the user to resolve via the loupe's Attach popover.
		console.warn('[wizard] terminal handoff conflict — leaving in right pane');
		return;
	}
	ps.setStudioAttachedTerminal(h.studioLeafId, h.terminalSessionId);
	ps.closePane(h.terminalLeafId);
}

/** Decide what to do with a fresh handoff: silently apply the persisted
 *  pref, or request a modal via the handoff store. */
export async function requestOrApplyHandoff(h: PendingHandoff): Promise<void> {
	const pref = await loadHandoffPref();
	if (pref === 'ask') {
		useHandoffStore.getState().request(h);
		return;
	}
	applyHandoff(pref, h);
}

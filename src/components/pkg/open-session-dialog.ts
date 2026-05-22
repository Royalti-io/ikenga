// Programmatic entry point for the shell's New-Session dialog. The verb
// `host.openSessionDialog` (WP-27, Round-7 follow-up) routes through here so
// the dialog itself becomes the single consent surface for any host-initiated
// chat or terminal session — the user reads the prompt in the dialog's
// editable textarea, picks Chat vs Terminal + engine + cwd, and clicks Start
// (or Cancel). G-SESSION-DIALOG.
//
// Two callers feed this:
//   - the pkg AppBridge verb (pkg-iframe-host.tsx) — scope-gated on
//     `engine:invoke`;
//   - the first-party artifact channel (iframe-registry.ts) — no scope
//     check, first-party.
// Both share this one core; the only thing that differs is the scope check
// outside it. The verb has no path that bypasses the dialog — the dialog IS
// the consent.
//
// WP-10's bespoke confirm modal + start-seeded-chat-confirmed.ts are deleted
// in the same series; the dialog supersedes them (strictly stronger consent:
// editable prompt + explicit target picker + explicit Start click).

import { create } from 'zustand';

export interface OpenSessionDialogOptions {
	/** Pre-fills the dialog's textarea. The user can read, edit, or wipe it
	 *  before clicking Start — this editability is the prompt-injection
	 *  mitigation that replaces WP-10's read-only confirm modal. */
	initialPrompt?: string;
	/** Optional thread/pane title hint. Not currently surfaced as a separate
	 *  field by the dialog (it derives the title from the prompt's first 80
	 *  chars); kept on the API so callers can label sessions when the dialog
	 *  grows a title field. */
	title?: string;
	/** Engine adapter id to pre-select (e.g. `'com.ikenga.engine-gemini'` or
	 *  the legacy `'claude-code'` stable id). The dialog enumerates installed
	 *  engines dynamically via `useEngineCatalog()`; this arg just sets the
	 *  initial highlight. No-op when the id isn't in the catalog. */
	engineId?: string;
	/** Pre-selects Chat vs Terminal toggle. Defaults to `'chat'`. */
	sessionKind?: 'chat' | 'terminal';
	/** Pre-selects the project-directory dropdown. The dialog enumerates
	 *  available cwds from the user's configured file roots / project
	 *  root_paths; passing a string that isn't in that list is a no-op (the
	 *  user keeps the default and can pick another). */
	cwd?: string;
	/** Audit stamp. Same shape as WP-22's `sendToActiveSession.source` —
	 *  prefixed onto the eventual prompt body as `[via: groundwork/<source>]`
	 *  so every dispatched first turn / terminal command carries provenance.
	 *  Defaults to `'unknown'`. */
	source?: string;
}

export type OpenSessionDialogResult =
	| { ok: true; kind: 'chat'; threadId: string }
	| { ok: true; kind: 'terminal'; paneId: string }
	| { ok: false; reason: 'cancelled' | 'scope-denied' };

// ── store ────────────────────────────────────────────────────────────────
//
// One in-flight programmatic open at a time. A second open while one is
// pending cancels the earlier one so the verb's promise never dangles (same
// pattern as `seed-chat-confirm-store.request` did, kept across the rework).

interface PendingOpen {
	args: OpenSessionDialogOptions;
	resolve: (result: OpenSessionDialogResult) => void;
}

interface OpenSessionDialogState {
	pending: PendingOpen | null;
	/** Workspace-mounted host calls this with the user's outcome. Clears
	 *  `pending` after resolving so the dialog closes. */
	settle: (result: OpenSessionDialogResult) => void;
	/** Used by `openSessionDialog()` below. Tests can also poke this. */
	request: (args: OpenSessionDialogOptions) => Promise<OpenSessionDialogResult>;
}

export const useOpenSessionDialogStore = create<OpenSessionDialogState>((set, get) => ({
	pending: null,
	settle: (result) => {
		const pending = get().pending;
		if (!pending) return;
		pending.resolve(result);
		set({ pending: null });
	},
	request: (args) =>
		new Promise<OpenSessionDialogResult>((resolve) => {
			const prior = get().pending;
			if (prior) prior.resolve({ ok: false, reason: 'cancelled' });
			set({ pending: { args, resolve } });
		}),
}));

/**
 * The verb-facing API. Opens the shell's New-Session dialog pre-filled with
 * `opts`, returns a promise that resolves when the user clicks Start or
 * Cancel.
 *
 *   `{ ok: true,  kind: 'chat',     threadId }` — user clicked Start in Chat mode
 *   `{ ok: true,  kind: 'terminal', paneId   }` — user clicked Start in Terminal mode
 *   `{ ok: false, reason: 'cancelled' }`         — user dismissed or clicked Cancel
 *   `{ ok: false, reason: 'scope-denied' }`      — caller (pkg) lacks `engine:invoke`
 *                                                  (this branch is produced by the
 *                                                  pkg-side dispatcher, NOT by the
 *                                                  dialog — the dialog never sees a
 *                                                  scope-denied flow)
 *
 * Source-stamp: if `opts.source` is set, the eventual mint (chat first turn
 * or terminal command body) carries `[via: groundwork/<source>]` as a
 * prefix. See `applySourceStampToArgs` below.
 */
export function openSessionDialog(
	opts: OpenSessionDialogOptions
): Promise<OpenSessionDialogResult> {
	const stamped = applySourceStampToArgs(opts);
	return useOpenSessionDialogStore.getState().request(stamped);
}

/**
 * Prefix the initial prompt with `[via: groundwork/<source>]` so the
 * audit-stamp lands in the eventual chat first turn or terminal command
 * body. Mirrors WP-22's pattern verbatim. Returns a new options object —
 * does not mutate `opts`.
 */
export function applySourceStampToArgs(
	opts: OpenSessionDialogOptions
): OpenSessionDialogOptions {
	const source = opts.source ?? 'unknown';
	const stamp = `[via: groundwork/${source}]`;
	const body = opts.initialPrompt ?? '';
	// If the user passed no prompt at all, still seed the stamp so callers
	// see provenance even on an empty kickoff. The dialog renders this in
	// the textarea — the user can wipe it before Start.
	const initialPrompt = body ? `${stamp}\n\n${body}` : stamp;
	return { ...opts, initialPrompt };
}

// ── dev / smoke convenience ─────────────────────────────────────────────
//
// Expose `window.openSessionDialog` in dev so engineers can drive the verb
// from DevTools without a pkg iframe. Mirrors the bg-spike convention
// (cfg-gated, deleted-after-sign-off is fine, but this one stays — same
// shape as the verb, no extra surface).

declare global {
	interface Window {
		openSessionDialog?: typeof openSessionDialog;
	}
}

if (typeof window !== 'undefined') {
	window.openSessionDialog = openSessionDialog;
}

// Shared core for `host.sendToActiveSession`: post a user turn into the
// focused chat pane's thread, source-stamped for audit.
//
// Sibling of `start-seeded-chat-confirmed.ts` (the WP-10 / WP-19 path that
// mints a fresh thread). This core targets the *existing* thread in the
// focused chat pane and dispatches through the same `appendUserTurn` →
// `adapter.send` → drain pipeline as `autoSendKickoff` in scaffold.ts.
//
// "Active session" = the chat pane that currently owns focus. If no chat
// pane is focused, the call refuses cleanly with
// `reason: 'no-active-session'` — there is no silent fallback to a stale
// thread or to minting a new one. Strict refusal is the safety floor (see
// 10-sendToActiveSession-verb.md §Prompt-injection notes).
//
// Source-stamp: every dispatched body is prefixed with
// `[via: groundwork/<source>] ` (default `unknown`) so the user (and any
// audit pass) can see which surface emitted the turn — board / palette /
// wp-card / etc. The user is already watching the thread the message lands
// in, so a per-call confirm modal would be friction without payoff; the
// source-stamp + strict refusal carry the audit-trail mitigation that
// `01-plan.md §Risks` asked for in this context.
//
// Used by both callers of the verb (signature frozen by `G-ACTIVE-SESSION`):
//   - the pkg AppBridge verb (pkg-iframe-host.tsx) — after its engine:invoke
//     scope check;
//   - the first-party artifact channel (iyke iframe-registry) — no scope
//     check, since plan-folder artifacts are first-party (mirrors WP-19's
//     Round-6 Opt-A).

import { appendUserTurn } from '@/chat/persist';
import { getAdapter } from '@/chat/registry';
import { useChatStore } from '@/chat/store';
import { findLeaf, getActiveView } from '@/lib/panes/pane-reducer';
import { usePaneStore } from '@/lib/panes/pane-store';

export interface SendToActiveSessionOptions {
	/** User-turn body. Will be source-stamped with `[via: groundwork/<source>]`
	 *  before dispatch. Required. */
	prompt: string;
	/** Audit tag — surfaces in the dispatched body as the
	 *  `[via: groundwork/<source>]` prefix. Defaults to `'unknown'` when omitted
	 *  so unfound callers still leave a trail. Conventional values:
	 *  `'board' | 'palette' | 'wp-card'`. */
	source?: string;
}

export type SendToActiveSessionResult =
	| { ok: true; threadId: string }
	| { ok: false; reason: 'no-active-session' | 'scope-denied' };

/** Build the source-stamped body that lands in the thread.
 *
 *  Exposed for tests + for callers who want to preview the dispatched body
 *  without actually sending (e.g. the palette's hover preview). */
export function sourceStamp(prompt: string, source: string | undefined): string {
	const tag = source && source.length > 0 ? `groundwork/${source}` : 'groundwork/unknown';
	return `[via: ${tag}] ${prompt}`;
}

/**
 * Resolve the focused chat pane → its thread id. Returns `null` when no
 * chat pane is focused (focused leaf doesn't exist, or its active tab isn't
 * a `kind: 'chat'` view). Strict — no fallback.
 *
 * Exported so the artifact-channel + verb paths can share the same
 * resolution, and so tests can drive it directly.
 */
export function resolveActiveChatThreadId(): string | null {
	const state = usePaneStore.getState();
	const leaf = findLeaf(state.root, state.focusedId);
	if (!leaf) return null;
	const view = getActiveView(leaf);
	if (!view || view.kind !== 'chat') return null;
	return view.sessionId;
}

/**
 * Append a source-stamped user turn to the focused chat pane's thread and
 * dispatch it through the same `appendUserTurn → adapter.send → drain`
 * pipeline `autoSendKickoff` uses (scaffold.ts).
 *
 * Refuses cleanly with `reason: 'no-active-session'` when no chat pane is
 * focused. Returns `{ ok: true, threadId }` once the user turn is appended
 * (the adapter.send drain runs in the background).
 *
 * Scope-checking is the caller's job — this core does **not** call
 * `pkgDeclaresScope` because the artifact-channel path (iframe-registry)
 * deliberately skips it (first-party). The pkg verb wraps this in an
 * `engine:invoke` check; the artifact channel calls it raw.
 */
export async function sendToActiveSession(
	opts: SendToActiveSessionOptions
): Promise<SendToActiveSessionResult> {
	const threadId = resolveActiveChatThreadId();
	if (!threadId) return { ok: false, reason: 'no-active-session' };

	const thread = useChatStore.getState().threads[threadId]?.thread;
	if (!thread) {
		// The focused pane references a thread id that the chat store hasn't
		// hydrated yet (race during reload, or the pane was mounted by some
		// path that bypassed `upsertThread`). Without an adapter id we can't
		// dispatch — treat as no active session rather than throwing, since
		// from the caller's perspective there's no live thread to target.
		return { ok: false, reason: 'no-active-session' };
	}

	const body = sourceStamp(opts.prompt, opts.source);

	// Append the user turn synchronously so the FE store + DB row both reflect
	// the turn before we hand off to the adapter (mirrors `autoSendKickoff`).
	const turn = await appendUserTurn(threadId, body);
	useChatStore.getState().appendEvents(threadId, [
		{
			kind: 'user_turn',
			text: turn.text,
			sequence: turn.sequence,
			createdAt: turn.createdAt,
		},
	]);

	// Fire-and-forget drain — the adapter's own listeners persist + push
	// events as they stream in. Errors flip the thread's status to 'error'
	// so the chat UI surfaces them; nothing here needs to await completion.
	const adapter = getAdapter(thread.adapterId);
	useChatStore.getState().setStatus(threadId, 'streaming');
	void (async () => {
		try {
			const { iterable } = adapter.send({ threadId, text: body });
			for await (const _ev of iterable) {
				// drain — listeners handle persistence + store updates
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error('[send-to-active-session] adapter send failed:', e);
			useChatStore.getState().setStatus(threadId, 'error', msg);
			return;
		} finally {
			if (useChatStore.getState().threads[threadId]?.status === 'streaming') {
				useChatStore.getState().setStatus(threadId, 'idle');
			}
		}
	})();

	return { ok: true, threadId };
}

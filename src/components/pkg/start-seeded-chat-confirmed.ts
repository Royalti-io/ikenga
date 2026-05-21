// Shared core for `host.startChatSession`: surface the seed prompt for user
// approval, then (if approved) start a seeded chat via WP-09's seam.
//
// Used by both callers of the verb:
//   - the pkg AppBridge verb (pkg-iframe-host.tsx) — after its engine:invoke
//     scope check;
//   - the first-party artifact channel (iyke iframe-registry) — no scope
//     check, since plan-folder artifacts are first-party.
// The user-confirm is the common gate (prompt-injection mitigation + rate
// gate); only the scope check differs between the two paths.

import { useSeedChatConfirmStore } from '@/components/pkg/seed-chat-confirm-store';
import { startSeededChat, type StartSeededChatOptions } from '@/shell/artifact-wizard/scaffold';

export interface ConfirmedSeedResult {
	ok: boolean;
	threadId?: string;
	paneId?: string;
	/** True when the user dismissed/cancelled the confirm. */
	declined?: boolean;
	/** Set when startSeededChat threw. */
	error?: string;
}

/**
 * Confirm the seed prompt with the user, then start the session. `requester`
 * is a human label (pkg id or artifact label) shown in the confirm dialog.
 */
export async function startSeededChatWithConfirm(
	requester: string,
	opts: StartSeededChatOptions
): Promise<ConfirmedSeedResult> {
	const approved = await useSeedChatConfirmStore.getState().request({
		requester,
		prompt: opts.prompt,
		title: opts.title ?? null,
	});
	if (!approved) return { ok: false, declined: true };
	try {
		const res = await startSeededChat(opts);
		return { ok: true, threadId: res.threadId, paneId: res.paneId };
	} catch (e) {
		return { ok: false, error: (e as Error).message ?? String(e) };
	}
}

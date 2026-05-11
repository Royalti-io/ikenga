// Phase 3 dev-only smoke binding. End-to-end exercise of the ACP path:
// initialize → new_session → listen → prompt → await done. The chat composer
// is still on the legacy `session_send` path (phase 10 swaps it); this
// helper exists purely so we can run the new path under iyke during dev
// without wiring a UI toggle.
//
// Bound to `globalThis.ikengaAcpSmoke` from `src/lib/dev/index.ts` in dev
// builds. From iyke:
//
//   iyke javascript "(await window.ikengaAcpSmoke('Reply with exactly: ACP-OK')).updates.length"

import {
	acpInitialize,
	acpListen,
	acpListenRequests,
	acpNewSession,
	acpPrompt,
	acpRespondPermission,
	acpSetMode,
	type AcpRequestEnvelope,
	type AcpSessionModeId,
	type AcpSessionModes,
	type AcpSessionNotification,
	type AcpSessionUpdate,
} from '@/lib/tauri-cmd';

export interface AcpSmokeResult {
	threadId: string;
	updates: AcpSessionUpdate[];
	stopReason: string;
	/** Phase 4: every `session/request_permission` we received during the
	 *  turn, in order. The smoke harness auto-responds with the first
	 *  option of each request (see `acpListenRequests` wire-up below). */
	permissionRequests: AcpRequestEnvelope[];
	/** Phase 5: the modes the server advertised on `session/new`. Useful
	 *  for asserting the four canonical modes are surfaced. */
	advertisedModes: AcpSessionModes | null;
	/** Phase 5: the final mode the session was in when the prompt fired
	 *  (after any optional `acpSetMode` call). When `opts.mode` is not
	 *  provided this is whatever the server advertised as `currentModeId`. */
	finalMode: AcpSessionModeId;
}

/**
 * Runs a single ACP prompt round-trip and returns every `SessionUpdate` the
 * agent emitted plus the final stop reason. The session is created fresh on
 * each call — we don't reuse a thread across smoke runs because we want
 * `acpPrompt` to observe spawn-time behavior too.
 *
 * `cwd` defaults to `$HOME` so we don't depend on the iyke caller having
 * already set a project root. Override if the smoke test is supposed to
 * exercise project-relative claude behavior.
 */
export async function runAcpSmokeTest(
	prompt: string,
	opts: { cwd?: string; mode?: AcpSessionModeId } = {}
): Promise<AcpSmokeResult> {
	const cwd = opts.cwd ?? '/';

	// Handshake. The response is ignored for now — phase 10 will use the
	// advertised capabilities to gate UI features.
	await acpInitialize({ protocolVersion: 1 });

	const session = await acpNewSession({ cwd, mcpServers: [] });
	const threadId = session.sessionId;
	const advertisedModes = session.modes ?? null;

	// Phase 5: optional mode switch right after `session/new`. Mirrors what
	// the composer mode picker does — change the tracked mode before the
	// first prompt so the spawn picks it up via `--permission-mode`.
	let finalMode: AcpSessionModeId =
		(advertisedModes?.currentModeId ?? 'default') as AcpSessionModeId;
	if (opts.mode && opts.mode !== finalMode) {
		await acpSetMode(threadId, opts.mode);
		finalMode = opts.mode;
	}

	const updates: AcpSessionUpdate[] = [];
	const unlisten = await acpListen(threadId, (notif: AcpSessionNotification) => {
		updates.push(notif.update);
	});

	// Phase 4: auto-respond to every `session/request_permission` with the
	// FIRST option in the request. For AskUserQuestion this picks the first
	// answer for the first question (encoded as `ask:0:<label>`); for
	// generic tools that's `allow_once`. The harness is for smoke runs —
	// the real UI lives in `PermissionDialog` (Phase 4.5 / Phase 10).
	const permissionRequests: AcpRequestEnvelope[] = [];
	const unlistenRequests = await acpListenRequests(threadId, (env: AcpRequestEnvelope) => {
		permissionRequests.push(env);
		const firstOption = env.request.options[0];
		if (!firstOption) {
			// Nothing to pick — synthesize a cancellation so claude doesn't
			// hang. The Rust side translates this to a `deny` envelope.
			void acpRespondPermission(env.requestId, {
				outcome: { outcome: 'cancelled' },
			});
			return;
		}
		void acpRespondPermission(env.requestId, {
			outcome: { outcome: 'selected', optionId: firstOption.optionId },
		});
	});

	let response;
	try {
		response = await acpPrompt({
			sessionId: threadId,
			prompt: [{ type: 'text', text: prompt }],
		});
	} finally {
		// Note: `acpPrompt` resolves the moment the Rust side sees `Done`,
		// but Tauri events may still flush a tick later. Don't unlisten
		// synchronously or we lose the tail; let the microtask queue
		// drain first.
		await Promise.resolve();
		unlisten();
		unlistenRequests();
	}

	return {
		threadId,
		updates,
		stopReason: response.stopReason,
		permissionRequests,
		advertisedModes,
		finalMode,
	};
}

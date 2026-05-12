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
	acpCancel,
	acpForkSession,
	acpInitialize,
	acpListen,
	acpListenNotify,
	acpListenRequests,
	acpNewSession,
	acpPrompt,
	acpRespondPermission,
	acpSetMode,
	type AcpContentBlock,
	type AcpForkResult,
	type AcpNotifyPayload,
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
	let finalMode: AcpSessionModeId = (advertisedModes?.currentModeId ??
		'default') as AcpSessionModeId;
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

/**
 * Phase 7: smoke-test sending an image through the ACP wire. The image
 * MUST be supplied as a data URL (e.g. `data:image/png;base64,...`) — we
 * don't read disk paths from the harness because the FileSystem API is
 * not directly available in webview contexts and the existing fs Tauri
 * commands are allowlist-scoped. iyke can build a data URL from a real
 * file with one round-trip:
 *
 *   const bytes = await invoke('fs_read', { path: '/abs/path.png' });
 *   const b64 = btoa(String.fromCharCode(...bytes.bytes));
 *   const dataUrl = `data:${bytes.mime};base64,${b64}`;
 *
 * Returns the same shape as `runAcpSmokeTest` so callers can assert on
 * `updates.length`, `stopReason`, etc. Bound to
 * `globalThis.ikengaAcpImageSmoke` from `src/lib/dev/index.ts`.
 *
 *   iyke javascript "(await window.ikengaAcpImageSmoke('What is in this?', dataUrl)).updates.length"
 */
export async function runAcpImageSmokeTest(
	prompt: string,
	imageDataUrl: string,
	opts: { cwd?: string } = {}
): Promise<AcpSmokeResult> {
	const cwd = opts.cwd ?? '/';

	// Parse the data URL — claude wants the raw base64 + the media_type,
	// not the prefixed URI form.
	const match = imageDataUrl.match(/^data:([^;,]+);base64,(.+)$/);
	if (!match) {
		throw new Error('imageDataUrl must be a base64 data URL like `data:image/png;base64,...`');
	}
	const mimeType = match[1];
	const data = match[2];

	await acpInitialize({ protocolVersion: 1 });

	const session = await acpNewSession({ cwd, mcpServers: [] });
	const threadId = session.sessionId;
	const advertisedModes = session.modes ?? null;
	const finalMode: AcpSessionModeId = (advertisedModes?.currentModeId ??
		'default') as AcpSessionModeId;

	const updates: AcpSessionUpdate[] = [];
	const unlisten = await acpListen(threadId, (notif: AcpSessionNotification) => {
		updates.push(notif.update);
	});

	const permissionRequests: AcpRequestEnvelope[] = [];
	const unlistenRequests = await acpListenRequests(threadId, (env: AcpRequestEnvelope) => {
		permissionRequests.push(env);
		const firstOption = env.request.options[0];
		if (!firstOption) {
			void acpRespondPermission(env.requestId, {
				outcome: { outcome: 'cancelled' },
			});
			return;
		}
		void acpRespondPermission(env.requestId, {
			outcome: { outcome: 'selected', optionId: firstOption.optionId },
		});
	});

	const blocks: AcpContentBlock[] = [
		{ type: 'text', text: prompt },
		{ type: 'image', data, mimeType },
	];

	let response;
	try {
		response = await acpPrompt({ sessionId: threadId, prompt: blocks });
	} finally {
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

/**
 * Phase 6: smoke-test the interrupt path. Sends a long-running prompt,
 * waits `delayMs`, fires `acpCancel`, then returns whatever updates
 * arrived. Should see partial assistant text followed by a Done with a
 * cancellation stop_reason.
 *
 * Important behavioral asserts the caller can make:
 *   - `updates.length > 0` — claude got far enough to stream something
 *     before the interrupt landed.
 *   - `stopReason === 'cancelled'` — claude acknowledged the interrupt
 *     via its normal `Done` envelope; we did NOT kill the child.
 *
 * Unlike `runAcpSmokeTest` we kick off `acpPrompt` without awaiting it
 * first, so the interrupt can race in while claude is mid-turn. The
 * promise is still awaited before we return so the caller observes the
 * full stop_reason rather than a synthesized one.
 *
 * Bound to `globalThis.ikengaAcpInterruptSmoke` from `src/lib/dev/index.ts`.
 * From iyke:
 *
 *   iyke javascript "(await window.ikengaAcpInterruptSmoke('Count from 1 to 100 slowly.')).stopReason"
 */
export async function runAcpInterruptSmokeTest(
	prompt: string,
	opts: { delayMs?: number; cwd?: string } = {}
): Promise<AcpSmokeResult> {
	const cwd = opts.cwd ?? '/';
	const delayMs = opts.delayMs ?? 500;

	await acpInitialize({ protocolVersion: 1 });

	const session = await acpNewSession({ cwd, mcpServers: [] });
	const threadId = session.sessionId;
	const advertisedModes = session.modes ?? null;
	const finalMode: AcpSessionModeId = (advertisedModes?.currentModeId ??
		'default') as AcpSessionModeId;

	const updates: AcpSessionUpdate[] = [];
	const unlisten = await acpListen(threadId, (notif: AcpSessionNotification) => {
		updates.push(notif.update);
	});

	// Mirror runAcpSmokeTest's auto-respond behavior — if claude happens
	// to ask for permission before we fire the interrupt, we don't want
	// the smoke to hang. Pick the first option.
	const permissionRequests: AcpRequestEnvelope[] = [];
	const unlistenRequests = await acpListenRequests(threadId, (env: AcpRequestEnvelope) => {
		permissionRequests.push(env);
		const firstOption = env.request.options[0];
		if (!firstOption) {
			void acpRespondPermission(env.requestId, {
				outcome: { outcome: 'cancelled' },
			});
			return;
		}
		void acpRespondPermission(env.requestId, {
			outcome: { outcome: 'selected', optionId: firstOption.optionId },
		});
	});

	// Kick the prompt off WITHOUT awaiting — we want the interrupt to
	// race in mid-turn. We still capture the eventual response so the
	// caller can assert on `stopReason`.
	const promptPromise = acpPrompt({
		sessionId: threadId,
		prompt: [{ type: 'text', text: prompt }],
	});

	// Schedule the interrupt. A real Stop click is similarly racy; the
	// fixed `delayMs` is just to give claude enough time to start
	// streaming so we can observe the partial-transcript behavior.
	await new Promise((resolve) => setTimeout(resolve, delayMs));
	await acpCancel(threadId);

	let response;
	try {
		response = await promptPromise;
	} finally {
		// Same tail-flush dance as runAcpSmokeTest: let pending Tauri
		// event microtasks drain before unlistening.
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

/**
 * Phase 8: smoke-test the fork path. Given a `sourceThreadId` (typically
 * minted via a prior `runAcpSmokeTest` so a real claude session exists),
 * fork it and return the result. The new thread's first prompt will
 * spawn `claude --resume <source_session_id>` so it resumes from the
 * same on-disk JSONL transcript — the fork relationship is recorded in
 * `chat_threads.branched_from` / `branched_from_turn`.
 *
 * Bound to `globalThis.ikengaAcpForkSmoke` from `src/lib/dev/index.ts`.
 * From iyke:
 *
 *   iyke javascript "(await window.ikengaAcpForkSmoke(sourceThreadId, { upToTurn: 1 })).newThreadId"
 */
export async function runAcpForkSmokeTest(
	sourceThreadId: string,
	opts: { upToTurn?: number; label?: string } = {}
): Promise<AcpForkResult> {
	return acpForkSession(sourceThreadId, opts);
}

/**
 * Phase 9: passively watch the global `acp://notify` channel for a window
 * of time and return every payload that arrived. Useful for smoke-testing
 * the OS-notification + sidebar-badge path without needing to actually
 * unfocus the app (we just assert the wire shape + that the Rust side
 * emitted something).
 *
 * Bound to `globalThis.ikengaAcpNotifyWatch` from `src/lib/dev/index.ts`.
 * From iyke (e.g. confirm a tool-permission request also emits a notify):
 *
 *   iyke javascript "const r = window.ikengaAcpNotifyWatch(15000); // trigger something; (await r).length"
 */
export async function watchAcpNotify(durationMs = 30000): Promise<AcpNotifyPayload[]> {
	const payloads: AcpNotifyPayload[] = [];
	const unlisten = await acpListenNotify((p) => {
		payloads.push(p);
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, durationMs));
	} finally {
		unlisten();
	}
	return payloads;
}

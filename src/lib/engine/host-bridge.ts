// Shell-side `HostBridge` wiring for the Claude Code engine adapter.
//
// The engine pkg (`@ikenga/pkg-engine-claude-code`) is a headless adapter that
// implements the `Engine` interface from `@ikenga/contract/engine`. It does
// not call `invoke()` directly — it talks to the host shell through this
// `HostBridge`, which adapts each engine-level operation onto the shell's
// session_* Tauri commands.
//
// v2: the engine's `Session.id` (a uuid minted by the engine via
// `crypto.randomUUID()`) is used as the shell's `threadId` directly. The
// shell maintains a stable Session keyed on that id; Claude's internal
// session id is metadata. No placeholder→real translation needed.
//
// `chatEventToEngineEvent` adapts the shell's richer `ChatEvent` union to
// the engine contract's `EngineEvent` (a strict subset). Unmapped variants
// are silently dropped — the engine doesn't model artifacts / hooks /
// user-turn echoes.
//
// Phase 10 — an additional `createShellAcpHost()` factory binds the ACP
// engine pkg to the shell's `acp*` Tauri-cmd wrappers. The host shape is
// the ACP-shaped sibling of `HostBridge`; both surfaces exist while the
// legacy engine path is retained for one release.

import {
	acpCancel,
	acpForkSession,
	acpInitialize,
	acpListen,
	acpListenNotify,
	acpListenRequests,
	acpLoadSession,
	acpNewSession,
	acpPrompt,
	acpRespondPermission,
	acpSetMode,
	sessionDestroy,
	sessionEnsure,
	sessionListen,
	sessionSend,
	type ChatEvent,
	type ClaudeOpts,
} from '@/lib/tauri-cmd';
import type { EngineEvent, McpServerSpec } from '@ikenga/contract/engine';
import type { AcpHost, HostBridge } from '@ikenga/pkg-engine-claude-code';

interface SessionRecord {
	/** Working directory used at spawn time. */
	cwd: string;
}

/** Sessions known to this bridge. `sessionId` is the engine's uuid which is
 *  also the shell's threadId — no translation. */
const sessions = new Map<string, SessionRecord>();

/**
 * Convert the shell's wire-format `ChatEvent` to the contract's
 * `EngineEvent`. Returns `null` when the event has no engine-level
 * representation (e.g. artifacts, system hooks, parse errors) — the iterator
 * skips those rather than fabricating data.
 */
export function chatEventToEngineEvent(event: ChatEvent): EngineEvent | null {
	switch (event.kind) {
		case 'text':
			return { type: 'message_delta', text: event.delta };
		case 'thinking':
			return { type: 'thinking_delta', text: event.delta };
		case 'tool_use':
			return {
				type: 'tool_use',
				tool: event.name,
				input: event.input,
				toolUseId: event.id,
			};
		case 'tool_result':
			return {
				type: 'tool_result',
				toolUseId: event.id,
				output: event.output,
				isError: event.isError,
			};
		case 'done': {
			// The shell emits richer telemetry on `done` (usage, totalCostUsd,
			// durationMs). The engine contract only carries usage tokens — we'd
			// need a separate `usage` event for that. For now collapse to a single
			// `done` and emit usage upstream of this mapper if the shape is known.
			const reason: EngineEvent & { type: 'done' } = {
				type: 'done',
				reason: event.stopReason === 'cancelled' ? 'cancel' : 'stop',
			};
			return reason;
		}
		case 'rate_limit':
			return {
				type: 'done',
				reason: 'error',
				error: 'rate_limited',
			};
		case 'parse_error':
			return {
				type: 'done',
				reason: 'error',
				error: `parse_error: ${event.message}`,
			};
		// session_init, artifact, system_hook, user_turn, control_request,
		// unknown: no engine equivalent. user_turn is a frontend-only echo of
		// what the user typed; the engine sees it via its own `send` call so
		// we don't replay it. control_request (Phase 4) is handled out-of-band
		// by the ACP server emitting a `session/request_permission` request;
		// legacy engine consumers ignore it.
		case 'session_init':
		case 'artifact':
		case 'system_hook':
		case 'user_turn':
		case 'control_request':
		case 'unknown':
			return null;
		default: {
			// Exhaustiveness guard — TS will flag if a new ChatEvent kind is added.
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

/**
 * Bridge `claudeListenSession` (a Tauri event subscription with a callback)
 * into an `AsyncIterable<EngineEvent>` that completes on `done`. Buffers
 * events between iterator pulls so nothing is dropped if the consumer is
 * slow.
 */
function listenAsAsyncIterable(threadId: string): AsyncIterable<EngineEvent> {
	return {
		[Symbol.asyncIterator]() {
			// Pending events waiting for the next iterator pull.
			const queue: EngineEvent[] = [];
			// Pull-side promise resolver, set when iterator awaits with empty queue.
			let resolveNext: ((ev: IteratorResult<EngineEvent>) => void) | null = null;
			let done = false;
			let unlistenPromise: Promise<() => void> | null = null;

			const push = (ev: EngineEvent) => {
				if (resolveNext) {
					const r = resolveNext;
					resolveNext = null;
					r({ value: ev, done: false });
				} else {
					queue.push(ev);
				}
				if (ev.type === 'done') {
					done = true;
					// Tear down the listener once the engine 'done' has been delivered.
					unlistenPromise?.then((u) => u()).catch(() => {});
				}
			};

			unlistenPromise = sessionListen(threadId, (chatEvent) => {
				const mapped = chatEventToEngineEvent(chatEvent);
				if (mapped) push(mapped);
			});

			return {
				async next(): Promise<IteratorResult<EngineEvent>> {
					if (queue.length > 0) {
						const value = queue.shift() as EngineEvent;
						return { value, done: false };
					}
					if (done) {
						return { value: undefined, done: true };
					}
					return new Promise<IteratorResult<EngineEvent>>((resolve) => {
						resolveNext = resolve;
					});
				},
				async return(): Promise<IteratorResult<EngineEvent>> {
					done = true;
					unlistenPromise?.then((u) => u()).catch(() => {});
					return { value: undefined, done: true };
				},
			};
		},
	};
}

/**
 * Construct a `HostBridge` adapter over the shell's Tauri commands.
 * Exported as a factory so tests can swap individual methods or stub the
 * whole surface.
 */
export function createShellHostBridge(): HostBridge {
	return {
		async spawn(opts) {
			// The engine's sessionId IS the shell's threadId — no translation.
			// `claude` honors a system prompt via the initial prompt arg, and the
			// shell's `sessionEnsure` is lazy (no actual process until first send),
			// so we kick the system prompt as the first send when present.
			const cwd = opts.cwd ?? '.';
			const claudeOpts: ClaudeOpts = {
				resumeSessionId: opts.resumeSessionId,
				model: opts.model,
			};
			await sessionEnsure(opts.sessionId, cwd, claudeOpts);
			sessions.set(opts.sessionId, { cwd });
			if (opts.systemPrompt) {
				await sessionSend(opts.sessionId, opts.systemPrompt);
			}
		},

		async send(sessionId, message) {
			if (!sessions.has(sessionId)) {
				throw new Error(`engine bridge: unknown session ${sessionId}`);
			}
			await sessionSend(sessionId, message);
		},

		async kill(sessionId) {
			if (!sessions.has(sessionId)) return; // idempotent
			try {
				await sessionDestroy(sessionId);
			} finally {
				sessions.delete(sessionId);
			}
		},

		listen(sessionId) {
			if (!sessions.has(sessionId)) {
				// Return an iterable that immediately yields a done/error so callers
				// don't hang waiting for events on an un-spawned session.
				return {
					[Symbol.asyncIterator]() {
						let yielded = false;
						return {
							async next(): Promise<IteratorResult<EngineEvent>> {
								if (yielded) return { value: undefined, done: true };
								yielded = true;
								return {
									value: {
										type: 'done',
										reason: 'error',
										error: `unknown session ${sessionId}`,
									},
									done: false,
								};
							},
						};
					},
				};
			}
			return listenAsAsyncIterable(sessionId);
		},

		async registerMcp(_spec: McpServerSpec) {
			// TODO(phase-engine): wire to a `claude_mcp_register` Tauri command
			// once the Rust side gains an MCP registry tied to live `claude` CLI
			// children. Today MCP servers are configured via `~/.claude/mcp.json`
			// out-of-band, so the engine's runtime registration is a no-op.
			return;
		},

		async unregisterMcp(_id: string) {
			// TODO(phase-engine): pair with `registerMcp` above.
			return;
		},
	};
}

/**
 * Phase 10 — construct the ACP-shaped host adapter the engine pkg consumes.
 *
 * Each method is a direct passthrough to the shell's `acp*` Tauri-cmd
 * wrapper. The shapes already match the contract (`AcpInitializeRequest`,
 * `AcpPromptRequest`, etc.), so this layer is mostly a type bridge — its
 * value is letting `pkgs/engine-claude-code` stay free of `@tauri-apps/*`
 * deps while the shell still owns the canonical wire layer.
 *
 * The two subscription helpers (`listenSession`, `listenPermissionRequests`,
 * `listenNotify`) hand back the underlying `UnlistenFn` so the engine pkg
 * can wrap them in a sync unsubscribe.
 */
export function createShellAcpHost(): AcpHost {
	return {
		initialize: (req) => acpInitialize(req),
		newSession: (req) => acpNewSession(req),
		prompt: (req) => acpPrompt(req),
		cancel: (sessionId) => acpCancel(sessionId),
		setMode: (sessionId, modeId) => acpSetMode(sessionId, modeId),
		loadSession: (sessionId) => acpLoadSession(sessionId),
		forkSession: (sourceSessionId, opts) => acpForkSession(sourceSessionId, opts),
		listenSession: (sessionId, onUpdate) => acpListen(sessionId, onUpdate),
		listenPermissionRequests: (sessionId, onRequest) => acpListenRequests(sessionId, onRequest),
		respondPermission: (requestId, response) => acpRespondPermission(requestId, response),
		listenNotify: (callback) => acpListenNotify(callback),
	};
}

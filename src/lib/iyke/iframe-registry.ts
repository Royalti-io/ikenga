// Registry of mini-app iframes by pane id. Each pane that mounts an
// iframe sidecar (storyboard, video-engine, hyperframes) registers its
// element here so the parent bridge can forward iyke://* requests to
// the right iframe via postMessage.
//
// Plus the postMessage dispatcher: a single window-level message
// listener routes replies back to pending RPC promises and pushes
// log/network entries (tagged with the source pane id) into the same
// ring buffers the shell uses.

import { invoke } from '@tauri-apps/api/core';

import { sendToActiveSession } from '@/components/pkg/send-to-active-session';
import { startSeededChatWithConfirm } from '@/components/pkg/start-seeded-chat-confirmed';

export interface IframeRegistration {
	paneId: string;
	iframe: HTMLIFrameElement;
	/** Mini-app name for diagnostics. */
	kind: string;
	/** Set true when we've seen a hello message from the iframe bridge. */
	bridged: boolean;
	/** Latest published state (Phase C — storyboard cursor, comp current frame, etc.). */
	state: Record<string, unknown>;
}

const registry = new Map<string, IframeRegistration>();

export function registerIykeIframe(
	paneId: string,
	iframe: HTMLIFrameElement,
	kind: string
): () => void {
	registry.set(paneId, { paneId, iframe, kind, bridged: false, state: {} });
	return () => {
		const cur = registry.get(paneId);
		if (cur && cur.iframe === iframe) registry.delete(paneId);
	};
}

/**
 * Resolve a pane id that may be a truncated prefix (the CLI's `iyke state`
 * prints the first 8 chars only — `iyke-cli/src/output.rs`) to the full
 * registered id. Exact match wins; otherwise a *unique* prefix match. Returns
 * undefined when nothing matches or the prefix is ambiguous (caller then
 * treats it as a non-iframe pane and falls back to host targeting).
 */
export function resolveIframePaneId(idOrPrefix: string): string | undefined {
	if (registry.has(idOrPrefix)) return idOrPrefix;
	const matches: string[] = [];
	for (const key of registry.keys()) if (key.startsWith(idOrPrefix)) matches.push(key);
	return matches.length === 1 ? matches[0] : undefined;
}

export function getIframe(paneId: string): IframeRegistration | undefined {
	const full = resolveIframePaneId(paneId);
	return full ? registry.get(full) : undefined;
}

export function listIframes(): IframeRegistration[] {
	return Array.from(registry.values());
}

let stateGeneration = 0;
export function bumpStateGeneration(): number {
	stateGeneration += 1;
	return stateGeneration;
}
export function currentStateGeneration(): number {
	return stateGeneration;
}

// ── pending RPC ──────────────────────────────────────────────────────────

interface PendingEntry<T = unknown> {
	resolve: (v: T) => void;
	reject: (err: Error) => void;
	timer: number;
}

const pending = new Map<string, PendingEntry>();

let reqCounter = 0;
function nextRequestId(prefix: string): string {
	reqCounter += 1;
	return `${prefix}-${Date.now().toString(36)}-${reqCounter}`;
}

function postWithReply<T>(
	paneId: string,
	kind: string,
	payload: unknown,
	timeoutMs = 5000
): Promise<T> {
	const reg = registry.get(resolveIframePaneId(paneId) ?? paneId);
	if (!reg) {
		return Promise.reject(new Error(`iyke iframe not registered: paneId=${paneId}`));
	}
	if (!reg.iframe.contentWindow) {
		return Promise.reject(new Error(`iyke iframe contentWindow missing: paneId=${paneId}`));
	}
	const requestId = nextRequestId(kind);
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			pending.delete(requestId);
			reject(
				new Error(
					`iyke iframe ${kind} timeout (${timeoutMs}ms): paneId=${paneId} bridged=${reg.bridged}`
				)
			);
		}, timeoutMs);
		pending.set(requestId, {
			resolve: resolve as (v: unknown) => void,
			reject,
			timer,
		});
		reg.iframe.contentWindow!.postMessage(
			{ __iyke: true, kind, request_id: requestId, payload },
			'*'
		);
	});
}

export function postToIframeFireAndForget(paneId: string, kind: string, payload: unknown): void {
	const reg = registry.get(resolveIframePaneId(paneId) ?? paneId);
	if (!reg || !reg.iframe.contentWindow) return;
	reg.iframe.contentWindow.postMessage({ __iyke: true, kind, payload }, '*');
}

export function requestIframeDom(
	paneId: string,
	query: string | undefined,
	all: boolean
): Promise<{ text: string; json: unknown; generation: number }> {
	return postWithReply(paneId, 'dom-request', { query, all }, 5000);
}

export function requestIframeWait(
	paneId: string,
	kind: string,
	value: string,
	timeoutMs: number
): Promise<{ satisfied: boolean; elapsed_ms: number; message?: string }> {
	return postWithReply(
		paneId,
		'wait-request',
		{ kind, value, timeout_ms: timeoutMs },
		timeoutMs + 1500
	);
}

// ── message dispatcher ───────────────────────────────────────────────────

interface IykeMsg {
	__iyke?: true;
	kind?: string;
	request_id?: string;
	payload?: unknown;
}

function findRegistrationByWindow(
	source: MessageEventSource | null
): IframeRegistration | undefined {
	if (!source) return undefined;
	for (const reg of registry.values()) {
		if (reg.iframe.contentWindow === source) return reg;
	}
	return undefined;
}

let listenerInstalled = false;

export function installIykeIframeMessageListener() {
	if (listenerInstalled) return;
	listenerInstalled = true;
	window.addEventListener('message', (e) => {
		const data = e.data as IykeMsg | undefined;
		if (!data || data.__iyke !== true) return;
		const reg = findRegistrationByWindow(e.source);
		const paneId = reg?.paneId;
		switch (data.kind) {
			case 'hello': {
				if (reg) reg.bridged = true;
				return;
			}
			case 'logs': {
				const batch = (data.payload as Array<Record<string, unknown>>).map((entry) => ({
					...entry,
					source: paneId ?? 'iframe',
				}));
				invoke('iyke_log_push', { entries: batch }).catch(() => {});
				return;
			}
			case 'network': {
				const batch = (data.payload as Array<Record<string, unknown>>).map((entry) => ({
					...entry,
					source: paneId ?? 'iframe',
				}));
				invoke('iyke_network_push', { entries: batch }).catch(() => {});
				return;
			}
			case 'state': {
				if (reg && data.payload) {
					const { key, value } = data.payload as { key: string; value: unknown };
					reg.state[key] = value;
					bumpStateGeneration();
				}
				return;
			}
			// First-party artifact channel for the seeded-session verb (Opt-A,
			// 04 Round 6). The pkg AppBridge has its own `host.startChatSession`
			// (scope-gated); artifacts are first-party so they skip the scope
			// check but share the same user-confirm + startSeededChat core.
			// Request/response: we post the result back keyed by `request_id`.
			case 'host.startChatSession': {
				const reqId = data.request_id;
				const src = e.source as Window | null;
				const respond = (result: unknown) => {
					if (!reqId || !src) return;
					try {
						src.postMessage(
							{
								__iyke: true,
								kind: 'host.startChatSession:result',
								request_id: reqId,
								payload: result,
							},
							'*'
						);
					} catch {}
				};
				const payload = (data.payload ?? {}) as Record<string, unknown>;
				const prompt = typeof payload.prompt === 'string' ? payload.prompt : null;
				if (!prompt) {
					respond({ ok: false, error: 'missing prompt' });
					return;
				}
				const projectId = typeof payload.projectId === 'string' ? payload.projectId : undefined;
				const title = typeof payload.title === 'string' ? payload.title : undefined;
				const engineId = typeof payload.engineId === 'string' ? payload.engineId : undefined;
				const split =
					payload.split === 'right' || payload.split === 'bottom' || payload.split === null
						? payload.split
						: undefined;
				void startSeededChatWithConfirm('this artifact', {
					prompt,
					projectId,
					title,
					engineId,
					split,
				}).then(respond);
				return;
			}
			// First-party artifact channel for the WP-22 attach verb. Mirrors
			// the startChatSession case immediately above: artifacts are
			// first-party so they skip the pkg `engine:invoke` scope check
			// (Round-6 Opt-A). No per-call confirm modal — see
			// plans/groundwork/10-* §Prompt-injection notes (locked
			// 2026-05-21). The source-stamp inside the core is the audit
			// trail; `reason: 'no-active-session'` is the safety floor.
			// Frozen by G-ACTIVE-SESSION — WP-21's palette codes against the
			// `{ ok, threadId?, reason? }` shape on the result message.
			case 'host.sendToActiveSession': {
				const reqId = data.request_id;
				const src = e.source as Window | null;
				const respond = (result: unknown) => {
					if (!reqId || !src) return;
					try {
						src.postMessage(
							{
								__iyke: true,
								kind: 'host.sendToActiveSession:result',
								request_id: reqId,
								payload: result,
							},
							'*'
						);
					} catch {}
				};
				const payload = (data.payload ?? {}) as Record<string, unknown>;
				const prompt = typeof payload.prompt === 'string' ? payload.prompt : null;
				if (!prompt) {
					respond({ ok: false, error: 'missing prompt' });
					return;
				}
				const source = typeof payload.source === 'string' ? payload.source : undefined;
				void sendToActiveSession({ prompt, source }).then(respond);
				return;
			}
			case 'dom-response':
			case 'wait-response':
			case 'click-ack':
			case 'type-ack':
			case 'key-ack':
			case 'pong': {
				if (!data.request_id) return;
				const entry = pending.get(data.request_id);
				if (!entry) return;
				clearTimeout(entry.timer);
				pending.delete(data.request_id);
				entry.resolve(data.payload);
				return;
			}
		}
	});
}

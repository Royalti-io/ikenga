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

export function getIframe(paneId: string): IframeRegistration | undefined {
	return registry.get(paneId);
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
	const reg = registry.get(paneId);
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
	const reg = registry.get(paneId);
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

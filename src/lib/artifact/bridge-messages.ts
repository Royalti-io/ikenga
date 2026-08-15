// Shared postMessage protocol between the shell (host) and an Ikenga artifact
// iframe (child). This file is safe to import from both sides; the child bundle
// (`bun run artifact:bundle`) inlines it, and the parent shell imports it to
// post messages and validate responses.
//
// The child iframe is sandboxed with `allow-scripts` but *without*
// `allow-same-origin`, so its document has an opaque origin and cannot read
// `window.parent`. All host/child coordination must go through `postMessage`.

export const IKENGA_HOST_MSG = '__ikenga_host';

/** Theme attributes the shell broadcasts and the child applies. */
export interface ThemePayload {
	mode: 'light' | 'dark';
	theme: string;
	density: string;
}

/** A DOM rect serialized for postMessage. */
export interface SerializedRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

/** A single pin resolution result. */
export interface PinResolution {
	selector: string;
	found: boolean;
	rect: SerializedRect | null;
}

/** Data needed to open the host context menu after a right-click pick. */
export interface PickPayload {
	/** CSS selector round-trippable via querySelector. */
	selector: string;
	/** Center of the element, fraction of the child's scroll viewport. */
	positionX: number;
	positionY: number;
	/** Base64 PNG of the element. */
	screenshotBase64: string;
	screenshotWidth: number;
	screenshotHeight: number;
	/** Short tag/text summary for the picker preview. */
	elementLabel: string;
	/** Cursor position inside the child viewport at the time of the pick. */
	clientX: number;
	clientY: number;
}

/** Messages sent from the host to the child iframe. */
export type HostToChildMessage =
	| { kind: 'ping' }
	| { kind: 'theme'; payload: ThemePayload }
	| { kind: 'start-pick' }
	| { kind: 'stop-pick' }
	| { kind: 'start-comment' }
	| { kind: 'stop-comment' }
	| { kind: 'start-text-edit' }
	| { kind: 'stop-text-edit' }
	| { kind: 'resolve-pins'; requestId: string; selectors: string[] }
	| { kind: 'watch-pins'; selectors: string[] }
	| { kind: 'unwatch-pins' }
	| { kind: 'capture'; requestId: string; selector: string };

/** Messages sent from the child iframe to the host. */
export type ChildToHostMessage =
	| { kind: 'ready' }
	| { kind: 'pong' }
	| { kind: 'pick'; payload: PickPayload }
	| { kind: 'hover'; rect: SerializedRect | null }
	| { kind: 'comment-pick'; payload: PickPayload }
	| { kind: 'text-edit-pick'; selector: string; rect: SerializedRect; originalHtml: string }
	| { kind: 'pins'; requestId: string; results: PinResolution[] }
	| { kind: 'pin-update'; results: PinResolution[] }
	| { kind: 'capture-result'; requestId: string; base64: string; width: number; height: number; error?: string }
	| { kind: 'text-edit-commit'; selector: string; innerHtml: string; originalHtml: string }
	| { kind: 'text-edit-cancel'; selector: string };

/** Wrapper the child must use so the host can distinguish Ikenga messages. */
export interface ChildMessageWrapper {
	[IKENGA_HOST_MSG]: true;
	/** Origin guard: opaque frames serialize as the string `"null"`. */
	origin: string;
	data: ChildToHostMessage;
}

/** Wrapper the host must use so the child can distinguish Ikenga messages. */
export interface HostMessageWrapper {
	[IKENGA_HOST_MSG]: true;
	data: HostToChildMessage;
}

export function isIkengaHostMessage(data: unknown): data is HostMessageWrapper | ChildMessageWrapper {
	return (
		typeof data === 'object' &&
		data !== null &&
		IKENGA_HOST_MSG in data &&
		(data as Record<string, unknown>)[IKENGA_HOST_MSG] === true &&
		'data' in data &&
		typeof (data as Record<string, unknown>).data === 'object'
	);
}

export function wrapHostMessage(data: HostToChildMessage): HostMessageWrapper {
	return { [IKENGA_HOST_MSG]: true, data };
}

export function wrapChildMessage(data: ChildToHostMessage): ChildMessageWrapper {
	return { [IKENGA_HOST_MSG]: true, origin: 'null', data };
}

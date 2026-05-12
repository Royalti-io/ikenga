// Iyke iframe bridge — canonical version. The ikenga-desktop shell
// owns this file. To install in a sidecar (storyboard-app, hyperframes,
// video-engine), run `ikenga-desktop/scripts/sync-iyke-iframe-bridge.sh`
// which copies this file into each sidecar's src dir. Each sidecar then
// imports `./iyke-bridge` and calls `mountIykeIframeBridge()` from main.
//
// The bridge:
//   1. Patches console + fetch + XHR to forward log/network entries to the
//      parent shell via postMessage (parent buffers them, tagged with the
//      pane id, so `iyke logs --source=<pane>` works).
//   2. Listens for iyke://* request messages from the parent and runs them
//      against the iframe's own document (DOM snapshot, click, type, key,
//      wait, query-cache), posting the result back.
//
// Dependencies: none. Self-contained. Runs in any modern browser context.

const PATCH_FLAG = Symbol.for('@royalti/iyke-iframe-bridge/patched');

interface IykeMessage<T = unknown> {
	__iyke: true;
	kind: string;
	request_id?: string;
	payload?: T;
}

interface MountOptions {
	/**
	 * Allowlisted parent origins for postMessage. Default accepts any origin,
	 * which is fine for localhost dev servers since the parent is itself
	 * running on tauri:// and these iframes are only ever embedded in PA. If
	 * you embed elsewhere, restrict to specific origins.
	 */
	allowedOrigins?: string[] | '*';
}

function postToParent<T>(msg: IykeMessage<T>) {
	if (window.parent && window.parent !== window) {
		window.parent.postMessage(msg, '*');
	}
}

// ── log + network capture ────────────────────────────────────────────────

interface LogBatch {
	ts: number;
	level: string;
	message: string;
	stack?: string;
}
interface NetworkBatch {
	ts: number;
	method: string;
	url: string;
	status?: number;
	duration_ms: number;
	kind: 'fetch' | 'xhr';
	error?: string;
}

const logBuffer: LogBatch[] = [];
const networkBuffer: NetworkBatch[] = [];
let logTimer: number | null = null;
let netTimer: number | null = null;

function flushLogs() {
	if (logTimer !== null) return;
	logTimer = window.setTimeout(() => {
		logTimer = null;
		if (logBuffer.length === 0) return;
		const batch = logBuffer.splice(0, logBuffer.length);
		postToParent({ __iyke: true, kind: 'logs', payload: batch });
	}, 250);
}

function flushNetwork() {
	if (netTimer !== null) return;
	netTimer = window.setTimeout(() => {
		netTimer = null;
		if (networkBuffer.length === 0) return;
		const batch = networkBuffer.splice(0, networkBuffer.length);
		postToParent({ __iyke: true, kind: 'network', payload: batch });
	}, 250);
}

function stringifyArgs(args: unknown[]): string {
	return args
		.map((a) => {
			if (a instanceof Error) return `${a.name}: ${a.message}`;
			if (typeof a === 'string') return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(' ');
}

function patchConsole() {
	const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
	for (const level of levels) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			try {
				logBuffer.push({
					ts: Date.now(),
					level,
					message: stringifyArgs(args),
					stack: level === 'error' ? new Error().stack : undefined,
				});
				if (logBuffer.length > 500) logBuffer.splice(0, logBuffer.length - 250);
				flushLogs();
			} catch {
				/* noop */
			}
			original(...args);
		};
	}
	window.addEventListener('error', (e) => {
		logBuffer.push({
			ts: Date.now(),
			level: 'error',
			message: e.message || 'window error',
			stack: e.error?.stack,
		});
		flushLogs();
	});
	window.addEventListener('unhandledrejection', (e) => {
		const reason = e.reason;
		logBuffer.push({
			ts: Date.now(),
			level: 'error',
			message:
				reason instanceof Error
					? `unhandled rejection: ${reason.message}`
					: `unhandled rejection: ${String(reason)}`,
			stack: reason instanceof Error ? reason.stack : undefined,
		});
		flushLogs();
	});
}

function patchFetch() {
	const original = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const start = performance.now();
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const method = (
			init?.method ?? (input instanceof Request ? input.method : 'GET')
		).toUpperCase();
		try {
			const res = await original(input as RequestInfo, init);
			networkBuffer.push({
				ts: Date.now(),
				method,
				url,
				status: res.status,
				duration_ms: Math.round(performance.now() - start),
				kind: 'fetch',
			});
			flushNetwork();
			return res;
		} catch (err) {
			networkBuffer.push({
				ts: Date.now(),
				method,
				url,
				duration_ms: Math.round(performance.now() - start),
				kind: 'fetch',
				error: err instanceof Error ? err.message : String(err),
			});
			flushNetwork();
			throw err;
		}
	};
}

function patchXhr() {
	const OrigOpen = XMLHttpRequest.prototype.open;
	const OrigSend = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.open = function (
		this: XMLHttpRequest,
		method: string,
		url: string | URL,
		...rest: unknown[]
	) {
		(this as XMLHttpRequest & { __iyke_method?: string; __iyke_url?: string }).__iyke_method =
			method.toUpperCase();
		(this as XMLHttpRequest & { __iyke_method?: string; __iyke_url?: string }).__iyke_url =
			typeof url === 'string' ? url : url.href;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return OrigOpen.apply(this, [method, url, ...(rest as any[])] as any);
	} as typeof XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.send = function (
		this: XMLHttpRequest,
		body?: Document | XMLHttpRequestBodyInit | null
	) {
		const xhr = this as XMLHttpRequest & { __iyke_method?: string; __iyke_url?: string };
		const start = performance.now();
		xhr.addEventListener('loadend', () => {
			networkBuffer.push({
				ts: Date.now(),
				method: xhr.__iyke_method ?? 'GET',
				url: xhr.__iyke_url ?? '',
				status: xhr.status || undefined,
				duration_ms: Math.round(performance.now() - start),
				kind: 'xhr',
				error: xhr.status === 0 && xhr.readyState === 4 ? 'network error' : undefined,
			});
			flushNetwork();
		});
		return OrigSend.call(this, body ?? null);
	};
}

// ── DOM snapshot (same shape as parent's dom-snapshot.ts) ────────────────

const SKIP_TAGS = new Set([
	'SCRIPT',
	'STYLE',
	'NOSCRIPT',
	'TEMPLATE',
	'META',
	'LINK',
	'TITLE',
	'HEAD',
]);

interface AxNode {
	ref: string;
	role: string;
	name?: string;
	value?: string;
	description?: string;
	checked?: boolean;
	selected?: boolean;
	disabled?: boolean;
	expanded?: boolean;
	children: AxNode[];
}

interface DomSnapshot {
	text: string;
	json: AxNode[];
	generation: number;
}

const refStore = new Map<string, Element>();
let generation = 0;

function takeSnapshot(query?: string, all?: boolean): DomSnapshot {
	generation += 1;
	refStore.clear();
	const counter = { n: 0 };
	const tree = walk(document.body, all === true, counter);
	const filtered = query ? filterByQuery(tree, query.toLowerCase()) : tree;
	return { text: renderText(filtered, 0), json: filtered, generation };
}

function walk(el: Element, all: boolean, counter: { n: number }): AxNode[] {
	if (counter.n >= 5000) return [];
	counter.n += 1;
	if (SKIP_TAGS.has(el.tagName)) return [];
	if (!all && !isVisible(el)) return [];

	const role = ariaRole(el);
	const name = accessibleName(el);
	const value = elementValue(el);

	const childNodes: AxNode[] = [];
	for (const child of Array.from(el.children)) {
		childNodes.push(...walk(child, all, counter));
	}
	const own = ownText(el);
	if (own && own.length > 0) {
		childNodes.unshift({ ref: assignRef(el), role: 'text', name: own, children: [] });
	}
	if (!isInteresting(role, name, value) && childNodes.length === 0) return [];
	if (!isInteresting(role, name, value) && childNodes.length > 0) return childNodes;

	const ref = assignRef(el);
	const node: AxNode = { ref, role, children: childNodes };
	if (name) node.name = name;
	if (value) node.value = value;
	const desc = el.getAttribute('aria-description') ?? el.getAttribute('title') ?? undefined;
	if (desc) node.description = desc;
	if (el.hasAttribute('aria-checked')) node.checked = el.getAttribute('aria-checked') === 'true';
	if (el.hasAttribute('aria-selected')) node.selected = el.getAttribute('aria-selected') === 'true';
	if (el.hasAttribute('aria-disabled') || (el as HTMLButtonElement).disabled)
		node.disabled =
			el.getAttribute('aria-disabled') === 'true' || Boolean((el as HTMLButtonElement).disabled);
	if (el.hasAttribute('aria-expanded')) node.expanded = el.getAttribute('aria-expanded') === 'true';
	return [node];
}

function assignRef(el: Element): string {
	for (const [k, v] of refStore) if (v === el) return k;
	const r = `e${refStore.size + 1}`;
	refStore.set(r, el);
	return r;
}

function isVisible(el: Element): boolean {
	if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return true;
	if (el.getAttribute('aria-hidden') === 'true') return false;
	const style = window.getComputedStyle(el as HTMLElement);
	if (style.display === 'none' || style.visibility === 'hidden') return false;
	if (el instanceof HTMLElement) {
		const r = el.getBoundingClientRect();
		if (r.width === 0 && r.height === 0 && el.children.length === 0) return false;
	}
	return true;
}

function isInteresting(role: string, name?: string, value?: string): boolean {
	if (role === 'text') return Boolean(name);
	const landmarks = [
		'banner',
		'navigation',
		'main',
		'complementary',
		'contentinfo',
		'form',
		'search',
		'region',
		'dialog',
		'alert',
		'status',
		'log',
		'progressbar',
		'tooltip',
	];
	if (landmarks.includes(role)) return true;
	const interactive = [
		'button',
		'link',
		'textbox',
		'searchbox',
		'combobox',
		'checkbox',
		'radio',
		'switch',
		'slider',
		'tab',
		'menuitem',
		'option',
		'listbox',
		'spinbutton',
	];
	if (interactive.includes(role)) return true;
	if (['heading', 'list', 'listitem', 'table', 'row', 'cell', 'img'].includes(role))
		return Boolean(name);
	if (value !== undefined && value !== '') return true;
	if (role === 'generic' && name) return true;
	return false;
}

function ownText(el: Element): string {
	let s = '';
	for (const c of Array.from(el.childNodes)) {
		if (c.nodeType === Node.TEXT_NODE) {
			const t = c.textContent;
			if (t) s += t;
		}
	}
	s = s.trim();
	if (s.length > 200) s = s.slice(0, 200) + '…';
	return s;
}

function ariaRole(el: Element): string {
	const explicit = el.getAttribute('role');
	if (explicit) return explicit;
	const tag = el.tagName.toLowerCase();
	switch (tag) {
		case 'a':
			return el.hasAttribute('href') ? 'link' : 'generic';
		case 'button':
			return 'button';
		case 'input': {
			const t = (el as HTMLInputElement).type;
			switch (t) {
				case 'button':
				case 'submit':
				case 'reset':
					return 'button';
				case 'checkbox':
					return 'checkbox';
				case 'radio':
					return 'radio';
				case 'range':
					return 'slider';
				case 'search':
					return 'searchbox';
				case 'number':
					return 'spinbutton';
				case 'hidden':
					return 'generic';
				default:
					return 'textbox';
			}
		}
		case 'textarea':
			return 'textbox';
		case 'select':
			return 'combobox';
		case 'option':
			return 'option';
		case 'h1':
		case 'h2':
		case 'h3':
		case 'h4':
		case 'h5':
		case 'h6':
			return 'heading';
		case 'nav':
			return 'navigation';
		case 'main':
			return 'main';
		case 'header':
			return 'banner';
		case 'footer':
			return 'contentinfo';
		case 'aside':
			return 'complementary';
		case 'section':
			return 'region';
		case 'form':
			return 'form';
		case 'ul':
		case 'ol':
			return 'list';
		case 'li':
			return 'listitem';
		case 'table':
			return 'table';
		case 'tr':
			return 'row';
		case 'td':
		case 'th':
			return 'cell';
		case 'img':
			return 'img';
		case 'dialog':
			return 'dialog';
		case 'progress':
			return 'progressbar';
		default:
			return 'generic';
	}
}

function accessibleName(el: Element): string | undefined {
	const al = el.getAttribute('aria-label');
	if (al) return al.trim();
	const lb = el.getAttribute('aria-labelledby');
	if (lb) {
		const parts = lb
			.split(/\s+/)
			.map((id) => document.getElementById(id)?.textContent ?? '')
			.filter(Boolean);
		if (parts.length > 0) return parts.join(' ').trim();
	}
	if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
		if (el.placeholder) return el.placeholder;
		const id = el.id;
		if (id) {
			const lbl = document.querySelector(`label[for="${cssEscape(id)}"]`);
			if (lbl) return (lbl.textContent ?? '').trim();
		}
	}
	if (el instanceof HTMLImageElement && el.alt) return el.alt;
	const tag = el.tagName.toLowerCase();
	if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary'].includes(tag)) {
		const t = (el.textContent ?? '').trim();
		if (t) return t.length > 200 ? t.slice(0, 200) + '…' : t;
	}
	return undefined;
}

function elementValue(el: Element): string | undefined {
	if (el instanceof HTMLInputElement) {
		if (el.type === 'hidden') return undefined;
		if (['checkbox', 'radio'].includes(el.type)) return undefined;
		return el.value || undefined;
	}
	if (el instanceof HTMLTextAreaElement) return el.value || undefined;
	if (el instanceof HTMLSelectElement) return el.value || undefined;
	return undefined;
}

function cssEscape(s: string): string {
	if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
	return s.replace(/[^\w-]/g, '\\$&');
}

function filterByQuery(nodes: AxNode[], q: string): AxNode[] {
	const out: AxNode[] = [];
	for (const n of nodes) {
		const match =
			n.role.toLowerCase().includes(q) ||
			(n.name?.toLowerCase().includes(q) ?? false) ||
			(n.value?.toLowerCase().includes(q) ?? false);
		const kids = filterByQuery(n.children, q);
		if (match || kids.length > 0) out.push({ ...n, children: match ? n.children : kids });
	}
	return out;
}

function renderText(nodes: AxNode[], depth: number): string {
	const lines: string[] = [];
	for (const n of nodes) {
		const indent = '  '.repeat(depth);
		const parts = [n.role];
		if (n.name) parts.push(JSON.stringify(n.name));
		parts.push(`[ref=${n.ref}]`);
		if (n.value) parts.push(`value=${JSON.stringify(n.value)}`);
		if (n.checked !== undefined) parts.push(n.checked ? 'checked' : 'unchecked');
		if (n.disabled) parts.push('disabled');
		if (n.expanded !== undefined) parts.push(n.expanded ? 'expanded' : 'collapsed');
		lines.push(indent + parts.join(' '));
		if (n.children.length > 0) lines.push(renderText(n.children, depth + 1));
	}
	return lines.filter((l) => l.length > 0).join('\n');
}

// ── action drivers ───────────────────────────────────────────────────────

function resolveTarget(
	ref?: string | null,
	selector?: string | null,
	text?: string | null
): Element | null {
	if (ref) {
		const el = refStore.get(ref);
		if (!el || !el.isConnected) {
			refStore.delete(ref ?? '');
			return null;
		}
		return el;
	}
	if (selector) {
		try {
			return document.querySelector(selector);
		} catch {
			return null;
		}
	}
	if (text) {
		const cands = document.querySelectorAll<HTMLElement>(
			'button, a, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=switch], label'
		);
		let best: HTMLElement | null = null;
		for (const el of Array.from(cands)) {
			const t = (el.innerText ?? el.textContent ?? '').trim();
			if (t.includes(text)) {
				if (!best || (best.contains(el) && el !== best)) best = el;
			}
		}
		return best;
	}
	return null;
}

function doClick(p: { ref?: string; selector?: string; text?: string }) {
	const el = resolveTarget(p.ref, p.selector, p.text);
	if (!el) return { ok: false, error: 'target not found' };
	if (el instanceof HTMLElement) {
		try {
			el.focus({ preventScroll: false });
		} catch {
			/* noop */
		}
		el.click();
	} else {
		el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	}
	return { ok: true };
}

function doType(p: { ref?: string; selector?: string; text: string; replace?: boolean }) {
	const el = resolveTarget(p.ref, p.selector, null);
	if (!el) return { ok: false, error: 'target not found' };
	if (
		el instanceof HTMLInputElement ||
		el instanceof HTMLTextAreaElement ||
		(el instanceof HTMLElement && el.isContentEditable)
	) {
		el.focus();
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			const setter = Object.getOwnPropertyDescriptor(
				el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
				'value'
			)?.set;
			const next = p.replace ? p.text : `${el.value}${p.text}`;
			if (setter) setter.call(el, next);
			else el.value = next;
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
		} else {
			if (p.replace) (el as HTMLElement).innerText = p.text;
			else (el as HTMLElement).innerText += p.text;
			el.dispatchEvent(new Event('input', { bubbles: true }));
		}
		return { ok: true };
	}
	return { ok: false, error: 'not editable' };
}

const KEY_ALIASES: Record<string, string> = {
	enter: 'Enter',
	esc: 'Escape',
	escape: 'Escape',
	tab: 'Tab',
	space: ' ',
	up: 'ArrowUp',
	down: 'ArrowDown',
	left: 'ArrowLeft',
	right: 'ArrowRight',
	backspace: 'Backspace',
	delete: 'Delete',
	home: 'Home',
	end: 'End',
};

function parseCombo(combo: string) {
	const parts = combo
		.split(/[+,]/)
		.map((p) => p.trim())
		.filter(Boolean);
	let key = '';
	let ctrl = false,
		alt = false,
		shift = false,
		meta = false;
	for (const p of parts) {
		const low = p.toLowerCase();
		if (low === 'ctrl' || low === 'control') ctrl = true;
		else if (low === 'alt' || low === 'option') alt = true;
		else if (low === 'shift') shift = true;
		else if (low === 'meta' || low === 'cmd' || low === 'command' || low === 'super') meta = true;
		else key = KEY_ALIASES[low] ?? p;
	}
	return { key, ctrl, alt, shift, meta };
}

function doKey(p: { combo: string; ref?: string; selector?: string }) {
	const target = resolveTarget(p.ref, p.selector, null) ?? document.activeElement ?? document.body;
	if (!target) return { ok: false, error: 'no target' };
	const c = parseCombo(p.combo);
	for (const type of ['keydown', 'keypress', 'keyup'] as const) {
		if (type === 'keypress' && c.key.length !== 1) continue;
		target.dispatchEvent(
			new KeyboardEvent(type, {
				key: c.key,
				code: c.key,
				ctrlKey: c.ctrl,
				altKey: c.alt,
				shiftKey: c.shift,
				metaKey: c.meta,
				bubbles: true,
				cancelable: true,
			})
		);
	}
	return { ok: true };
}

async function doWait(p: {
	kind: 'text' | 'selector' | 'ref' | 'gone-text' | 'gone-selector';
	value: string;
	timeout_ms: number;
}): Promise<{ satisfied: boolean; elapsed_ms: number; message?: string }> {
	const start = performance.now();
	const deadline = start + p.timeout_ms;
	const check = () => {
		switch (p.kind) {
			case 'text':
				return Boolean(document.body && document.body.innerText.includes(p.value));
			case 'gone-text':
				return !(document.body && document.body.innerText.includes(p.value));
			case 'selector': {
				const el = (() => {
					try {
						return document.querySelector(p.value);
					} catch {
						return null;
					}
				})();
				return Boolean(el && el instanceof HTMLElement && el.offsetParent !== null);
			}
			case 'gone-selector': {
				const el = (() => {
					try {
						return document.querySelector(p.value);
					} catch {
						return null;
					}
				})();
				return !el || (el instanceof HTMLElement && el.offsetParent === null);
			}
			case 'ref': {
				const el = refStore.get(p.value);
				return Boolean(el && el.isConnected);
			}
		}
	};
	return new Promise((resolve) => {
		const tick = () => {
			const now = performance.now();
			if (check()) {
				resolve({ satisfied: true, elapsed_ms: Math.round(now - start) });
				return;
			}
			if (now >= deadline) {
				resolve({
					satisfied: false,
					elapsed_ms: Math.round(now - start),
					message: `timeout after ${p.timeout_ms}ms (kind=${p.kind})`,
				});
				return;
			}
			setTimeout(tick, 50);
		};
		tick();
	});
}

// ── postMessage protocol ─────────────────────────────────────────────────

interface DomRequest {
	query?: string;
	all?: boolean;
}

function handleMessage(msg: IykeMessage<unknown>) {
	if (!msg || msg.__iyke !== true) return;
	const reqId = msg.request_id;
	switch (msg.kind) {
		case 'dom-request': {
			const p = (msg.payload ?? {}) as DomRequest;
			const r = takeSnapshot(p.query, p.all);
			postToParent({
				__iyke: true,
				kind: 'dom-response',
				request_id: reqId,
				payload: r,
			});
			break;
		}
		case 'click': {
			const r = doClick(msg.payload as { ref?: string; selector?: string; text?: string });
			postToParent({ __iyke: true, kind: 'click-ack', request_id: reqId, payload: r });
			break;
		}
		case 'type': {
			const r = doType(
				msg.payload as { ref?: string; selector?: string; text: string; replace?: boolean }
			);
			postToParent({ __iyke: true, kind: 'type-ack', request_id: reqId, payload: r });
			break;
		}
		case 'key': {
			const r = doKey(msg.payload as { combo: string; ref?: string; selector?: string });
			postToParent({ __iyke: true, kind: 'key-ack', request_id: reqId, payload: r });
			break;
		}
		case 'wait-request': {
			const p = msg.payload as {
				kind: 'text' | 'selector' | 'ref' | 'gone-text' | 'gone-selector';
				value: string;
				timeout_ms: number;
			};
			doWait(p).then((r) =>
				postToParent({
					__iyke: true,
					kind: 'wait-response',
					request_id: reqId,
					payload: r,
				})
			);
			break;
		}
		case 'ping': {
			postToParent({ __iyke: true, kind: 'pong', request_id: reqId });
			break;
		}
	}
}

// ── public mount ─────────────────────────────────────────────────────────

export interface IykeIframeBridgeHandle {
	/** Submit ad-hoc state (e.g. storyboard cursor) to the parent for Phase C reads. */
	publishState(key: string, value: unknown): void;
}

export function mountIykeIframeBridge(_opts: MountOptions = {}): IykeIframeBridgeHandle {
	const g = globalThis as typeof globalThis & { [PATCH_FLAG]?: boolean };
	if (!g[PATCH_FLAG]) {
		g[PATCH_FLAG] = true;
		patchConsole();
		patchFetch();
		patchXhr();
	}
	window.addEventListener('message', (e) => {
		handleMessage(e.data as IykeMessage<unknown>);
	});
	// Announce presence so the parent knows this iframe is bridged.
	postToParent({ __iyke: true, kind: 'hello' });

	return {
		publishState(key, value) {
			postToParent({ __iyke: true, kind: 'state', payload: { key, value } });
		},
	};
}

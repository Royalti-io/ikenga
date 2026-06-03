// DOM-to-PNG capture helper. Pure FE — Wayland/GNOME has no usable
// compositor screencopy without a portal prompt and Tauri 2 doesn't
// expose `WebviewWindow::capture` on Linux, so we draw the live React
// tree ourselves via `modern-screenshot`. Works regardless of focus or
// minimized state because the DOM stays mounted in memory.
//
// The Rust side calls `screenshot://request` events with a request_id;
// we encode and post the bytes back through `screenshot_capture_done`.

import { domToBlob } from 'modern-screenshot';

export interface CaptureOutput {
	base64: string;
	width: number;
	height: number;
}

// Hard ceiling on how long a single FE capture may take. Picked below
// the Rust-side 60s timeout so we always return a meaningful error
// (rather than letting the Rust oneshot expire silently).
//
// NOTE: this is a `setTimeout` race, so it only backstops *async* hangs
// (a same-origin image/font fetch that never resolves). It cannot rescue
// a *synchronous* main-thread block — `domToBlob` deep-clones the target
// and runs `getComputedStyle` per node before yielding, and on the whole
// `document.documentElement` (the window capture) that walk plus the
// final canvas encode is what used to freeze the UI past this timeout.
// Protection against that comes from `isUnwalkableIframe` (prune
// cross-origin panes from the clone) and `clampScale` (bound the canvas),
// below — not from this race.
const FE_CAPTURE_TIMEOUT_MS = 30_000;

// WebKitGTK (our Linux engine) caps usable canvas area well below desktop
// GPUs; ~16.7M px (4096²-class) is the broadly-safe cross-engine ceiling.
// Staying under it keeps a 4K/HiDPI full-window capture from allocating a
// canvas the engine silently fails (blank PNG) or chokes encoding.
export const MAX_CAPTURE_PIXELS = 16_000_000;
// Per-dimension belt-and-suspenders: modern-screenshot's maximumCanvasSize
// clamps canvas.width/height independently. 8192 covers any single edge.
const MAX_CANVAS_EDGE = 8192;

// Clamp devicePixelRatio so width * height * scale^2 <= MAX_CAPTURE_PIXELS.
// `Math.max(1, …)` keeps normal-sized windows at native density (the clamp
// only bites on very large windows) and never downscales below CSS res.
export function clampScale(cssWidth: number, cssHeight: number): number {
	const dpr = window.devicePixelRatio || 1;
	const cssArea = Math.max(1, cssWidth) * Math.max(1, cssHeight);
	const maxScale = Math.sqrt(MAX_CAPTURE_PIXELS / cssArea);
	return Math.max(1, Math.min(dpr, maxScale));
}

// True when modern-screenshot cannot walk into this iframe's document.
// Accessing contentDocument / contentWindow.location.href on a cross-origin
// frame throws SecurityError; a null contentDocument means not-yet-loaded —
// both are unwalkable. Same-origin frames (incl. about:blank, srcdoc, and
// the same-origin viewer-server frames on our own origin) do not throw and
// stay walkable, preserving the same-origin iframe rendering added in
// f144a1d. We DROP only frames we can't walk: their inner content can't
// reach the PNG either way, but attempting the walk bloats the synchronous
// clone (and cross-origin panes like storyboard :3105 / video-engine are
// the heaviest offenders on the window capture).
export function isUnwalkableIframe(el: Element): boolean {
	if (el.tagName !== 'IFRAME') return false;
	const iframe = el as HTMLIFrameElement;
	try {
		const doc = iframe.contentDocument;
		if (!doc) return true;
		void iframe.contentWindow?.location.href; // throws if cross-origin
		return false;
	} catch {
		return true;
	}
}

/**
 * Render the given element (or `document.documentElement` for the whole
 * window) to a PNG, return base64 + dimensions. Throws on failure — the
 * caller decides what to do.
 */
export async function captureToPng(target: HTMLElement): Promise<CaptureOutput> {
	// `scale: window.devicePixelRatio` keeps Retina/HiDPI sharp without
	// reading the actual compositor; `backgroundColor: null` preserves
	// transparency edges from rounded panel borders.
	//
	// Iframes are walked into (since Phase 1 same-origin viewer-server) so
	// artifact pane content reaches the PNG. `data-screenshot="skip"` opts
	// a node out.
	//
	// `font: false` skips `embedWebFont` entirely. The shell's index.html
	// loads Google Fonts via `<link>`; the resulting cross-origin
	// CSSStyleSheet throws SecurityError on `cssRules` access (which
	// modern-screenshot catches but logs). Either way no fonts are
	// inlined — system fallbacks render fine, the SVG foreignObject uses
	// whatever the browser already has loaded. Skipping saves the
	// stylesheet walk + any same-origin @font-face URL fetches.
	//
	// `fetch.requestInit.cache: 'force-cache'` keeps any unforeseen image
	// fetches from re-hitting the network on every capture.
	//
	// `timeout: 3000` lowers modern-screenshot's per-request fetch
	// timeout (default 30s) so a hypothetical hung external fetch can't
	// eat the entire FE_CAPTURE_TIMEOUT_MS budget. With `font: false`
	// there should be no network at all on the steady-state path; this
	// is defence-in-depth for future iframe content that might inline
	// remote images.
	const rect = target.getBoundingClientRect();
	const scale = clampScale(rect.width, rect.height);

	const blobPromise = domToBlob(target, {
		scale,
		maximumCanvasSize: MAX_CANVAS_EDGE,
		type: 'image/png',
		backgroundColor: null,
		font: false,
		timeout: 3000,
		filter: (node) => {
			if (!(node instanceof Element)) return true;
			if (node.getAttribute('data-screenshot') === 'skip') return false;
			if (isUnwalkableIframe(node)) return false;
			return true;
		},
		fetch: { requestInit: { cache: 'force-cache' } },
	});

	// Race the capture against a hard ceiling so cross-origin iframe hangs
	// surface as a clean FE error rather than a silent 60s Rust-side wait.
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(
				new Error(
					`capture exceeded ${FE_CAPTURE_TIMEOUT_MS}ms (likely a cross-origin iframe or pending fetch)`
				)
			);
		}, FE_CAPTURE_TIMEOUT_MS);
	});

	let blob: Blob | null;
	try {
		blob = await Promise.race([blobPromise, timeoutPromise]);
	} finally {
		if (timeoutId !== null) clearTimeout(timeoutId);
	}
	if (!blob) throw new Error('capture produced empty blob');

	const buf = new Uint8Array(await blob.arrayBuffer());
	const base64 = uint8ToBase64(buf);
	// Reuse the clamped `scale` (not a fresh devicePixelRatio) so reported
	// dimensions match the actual PNG when the budget clamp kicked in.
	return {
		base64,
		width: Math.max(1, Math.round(rect.width * scale)),
		height: Math.max(1, Math.round(rect.height * scale)),
	};
}

/** Capture the whole webview viewport. */
export function captureWindow(): Promise<CaptureOutput> {
	return captureToPng(document.documentElement);
}

/** Resolve a pane element by `data-pane-id`, or `null` if not mounted. */
export function findPaneElement(paneId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-pane-id="${cssEscape(paneId)}"]`);
}

/** Capture a single pane by `data-pane-id`. Throws if the pane isn't
 *  mounted — the caller should treat that as a 404. */
export function capturePane(paneId: string): Promise<CaptureOutput> {
	const el = findPaneElement(paneId);
	if (!el) throw new Error(`pane not found: ${paneId}`);
	return captureToPng(el);
}

// True when the pane element's *own* DOM scrolls beyond its box — i.e. there
// is content above/below or left/right of the visible area that a native
// window-crop (which only sees on-screen pixels) would miss. Artifact panes
// scroll *inside* a same-origin iframe, not the pane element itself, and
// modern-screenshot only renders the iframe's visible box anyway — so those
// report `false` and correctly route to the cheap native crop. The 8px slop
// absorbs sub-pixel layout rounding.
export function paneHasOwnOverflow(el: HTMLElement): boolean {
	return el.scrollHeight > el.clientHeight + 8 || el.scrollWidth > el.clientWidth + 8;
}

// Count elements in the subtree that the FE clone would have to walk,
// including same-origin iframe documents (cross-origin frames are pruned by
// `isUnwalkableIframe` and don't count). This is the cost proxy for the
// synchronous `getComputedStyle`-per-node clone that can stall — and on
// WebKitGTK abort — the renderer.
export function subtreeNodeCount(el: HTMLElement): number {
	let n = el.getElementsByTagName('*').length;
	const frames = el.getElementsByTagName('iframe');
	for (let i = 0; i < frames.length; i++) {
		try {
			const doc = frames[i].contentDocument;
			if (doc) n += doc.getElementsByTagName('*').length;
		} catch {
			// cross-origin — not walked, not counted.
		}
	}
	return n;
}

// Hard ceiling on FE-clone subtree size. Above this we refuse to attempt the
// synchronous clone (which would risk a renderer abort) and return a clean
// error instead. Set well above any real artifact — a normal heavy board is
// a few thousand nodes — so this only catches pathological/runaway DOMs.
export const FE_CLONE_NODE_CEILING = 50_000;

// Tiny base64 encoder for binary buffers — `btoa` chokes on non-Latin1
// bytes, and PNG has plenty. Done in 32KB chunks so we don't blow the
// argument-list limit on `String.fromCharCode.apply`.
function uint8ToBase64(buf: Uint8Array): string {
	const CHUNK = 0x8000;
	let s = '';
	for (let i = 0; i < buf.length; i += CHUNK) {
		s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK) as unknown as number[]);
	}
	return btoa(s);
}

// Quote-safe attribute selector. CSS.escape is widely available but not
// in jsdom; this fallback covers the characters our pane ids actually use.
function cssEscape(v: string): string {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
		return CSS.escape(v);
	}
	return v.replace(/["\\]/g, '\\$&');
}

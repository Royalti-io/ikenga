// Accessibility-tree snapshot generator. Walks the DOM, computes ARIA
// role/name/value for each interactive or landmark element, hands out
// refs (e1, e2, ...) that stay valid until the next snapshot bumps the
// generation counter.
//
// Refs follow Playwright's pattern: text-format snapshot for grep-friendly
// reading, parallel structured JSON, and a Map<refId, Element>
// callers consult to resolve a ref back to a live element.

const MAX_NODES = 5000;
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

const INLINE_ROLES = new Set(['text', 'StaticText', 'string']);

export interface AxNode {
	ref: string;
	role: string;
	name?: string;
	value?: string;
	description?: string;
	level?: number;
	checked?: boolean;
	selected?: boolean;
	disabled?: boolean;
	expanded?: boolean;
	children: AxNode[];
}

export interface DomSnapshotResult {
	text: string;
	json: AxNode[];
	generation: number;
}

const refStore = new Map<string, Element>();
let generation = 0;

export function resolveRef(ref: string): Element | null {
	const el = refStore.get(ref);
	if (!el || !el.isConnected) {
		refStore.delete(ref);
		return null;
	}
	return el;
}

export function currentGeneration(): number {
	return generation;
}

interface SnapshotOptions {
	query?: string;
	all?: boolean;
	root?: Element;
}

export function takeSnapshot(opts: SnapshotOptions = {}): DomSnapshotResult {
	generation += 1;
	refStore.clear();

	const root = opts.root ?? document.body;
	const counter = { n: 0, refs: 0 };
	const tree = walk(root, opts, counter);

	const filtered = opts.query ? filterByQuery(tree, opts.query.toLowerCase()) : tree;
	const text = renderText(filtered, 0);
	return { text, json: filtered, generation };
}

function walk(el: Element, opts: SnapshotOptions, counter: { n: number; refs: number }): AxNode[] {
	if (counter.n >= MAX_NODES) return [];
	counter.n += 1;
	if (SKIP_TAGS.has(el.tagName)) return [];
	if (!opts.all && !isVisible(el)) return [];

	// Same-origin iframes (pkg panes are srcdoc → parent-origin) are
	// transparent: descend into their document so `iyke dom` sees pane
	// content without any iframe-side bridge. Cross-origin iframes throw /
	// return null on contentDocument access and stay opaque.
	if (el.tagName === 'IFRAME') {
		const innerBody = sameOriginIframeBody(el as HTMLIFrameElement);
		if (innerBody) {
			const ref = assignRef(el);
			const name = el.getAttribute('data-pkg-id') ?? el.getAttribute('title') ?? el.id ?? undefined;
			const node: AxNode = {
				ref,
				role: 'iframe',
				children: walk(innerBody, opts, counter),
			};
			if (name) node.name = name;
			return [node];
		}
		// fall through — opaque iframe, treated like any other element
	}

	const role = ariaRole(el);
	const name = accessibleName(el);
	const value = elementValue(el);

	const childNodes: AxNode[] = [];
	for (const child of Array.from(el.children)) {
		childNodes.push(...walk(child, opts, counter));
	}

	// Promote text content as a leaf when the element itself isn't
	// interesting and has only text — keeps the tree shallow without
	// dropping content.
	const own = ownText(el);
	if (own && own.length > 0) {
		childNodes.unshift({
			ref: assignRef(el),
			role: 'text',
			name: own,
			children: [],
		});
	}

	if (!isInteresting(el, role, name, value) && childNodes.length === 0) {
		return [];
	}
	if (!isInteresting(el, role, name, value) && childNodes.length > 0) {
		// Collapse uninteresting wrapper into its children.
		return childNodes;
	}

	counter.refs += 1;
	const ref = assignRef(el);

	const node: AxNode = {
		ref,
		role,
		children: childNodes,
	};
	if (name) node.name = name;
	if (value) node.value = value;
	const desc = el.getAttribute('aria-description') ?? el.getAttribute('title') ?? undefined;
	if (desc) node.description = desc;

	if (el.hasAttribute('aria-checked')) {
		node.checked = el.getAttribute('aria-checked') === 'true';
	}
	if (el.hasAttribute('aria-selected')) {
		node.selected = el.getAttribute('aria-selected') === 'true';
	}
	if (el.hasAttribute('aria-disabled') || (el as HTMLButtonElement).disabled) {
		node.disabled =
			el.getAttribute('aria-disabled') === 'true' || Boolean((el as HTMLButtonElement).disabled);
	}
	if (el.hasAttribute('aria-expanded')) {
		node.expanded = el.getAttribute('aria-expanded') === 'true';
	}

	return [node];
}

/** The iframe's document body when it is same-origin-readable, else null. */
export function sameOriginIframeBody(iframe: HTMLIFrameElement): HTMLElement | null {
	try {
		return iframe.contentDocument?.body ?? null;
	} catch {
		return null; // cross-origin
	}
}

/**
 * The host document plus every same-origin iframe document reachable from it
 * (recursively — srcdoc pkg iframes inherit the parent origin). Used by the
 * selector/text resolvers and wait predicates so targets inside pkg panes
 * resolve without an iframe-side bridge.
 */
export function allSearchDocs(root: Document = document): Document[] {
	const out: Document[] = [root];
	for (const frame of Array.from(root.querySelectorAll('iframe'))) {
		const body = sameOriginIframeBody(frame);
		if (body?.ownerDocument) out.push(...allSearchDocs(body.ownerDocument));
	}
	return out;
}

function assignRef(el: Element): string {
	// Reuse existing ref when an element appears more than once via the
	// text-promotion path.
	for (const [k, v] of refStore) {
		if (v === el) return k;
	}
	const ref = `e${refStore.size + 1}`;
	refStore.set(ref, el);
	return ref;
}

function isVisible(el: Element): boolean {
	if (el.getAttribute('aria-hidden') === 'true') return false;
	// Use the element's own window — host getComputedStyle on an element from
	// an iframe document returns unreliable results across engines. (No
	// instanceof HTMLElement gating here: it fails across realms — iframe
	// documents have their own constructors.)
	const win = el.ownerDocument.defaultView ?? window;
	const style = win.getComputedStyle(el);
	if (style.display === 'none' || style.visibility === 'hidden') return false;
	// 0-size elements with no children. Allow size=0 for input[type=hidden]-style cases.
	const rect = el.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0 && el.children.length === 0) {
		// Inputs with type=hidden are intentionally 0-size. Keep them in --all only.
		return false;
	}
	return true;
}

function isInteresting(_el: Element, role: string, name?: string, value?: string): boolean {
	if (INLINE_ROLES.has(role)) return Boolean(name);
	// Always keep landmarks.
	if (
		[
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
		].includes(role)
	) {
		return true;
	}
	// Anything interactive.
	if (
		[
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
		].includes(role)
	) {
		return true;
	}
	if (['heading', 'list', 'listitem', 'table', 'row', 'cell', 'img'].includes(role)) {
		return Boolean(name);
	}
	if (value !== undefined && value !== '') return true;
	// Generic with name (e.g. ARIA-labeled containers).
	if (role === 'generic' && name) return true;
	// Otherwise drop and let children promote.
	return false;
}

function ownText(el: Element): string {
	let s = '';
	for (const child of Array.from(el.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE) {
			const t = child.textContent;
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
			.map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
			.filter(Boolean);
		if (parts.length > 0) return parts.join(' ').trim();
	}
	// instanceof checks fail across realms (iframe docs have their own
	// HTMLInputElement constructor), so test by tag name instead.
	const tagName = el.tagName;
	if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
		const field = el as HTMLInputElement | HTMLTextAreaElement;
		if (field.placeholder) return field.placeholder;
		const id = field.id;
		if (id) {
			const lbl = el.ownerDocument.querySelector(`label[for="${cssEscape(id)}"]`);
			if (lbl) return (lbl.textContent ?? '').trim();
		}
	}
	if (tagName === 'IMG' && (el as HTMLImageElement).alt) return (el as HTMLImageElement).alt;
	// For buttons + links + headings: use text content.
	const tag = el.tagName.toLowerCase();
	if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary'].includes(tag)) {
		const t = (el.textContent ?? '').trim();
		if (t) return t.length > 200 ? t.slice(0, 200) + '…' : t;
	}
	return undefined;
}

function elementValue(el: Element): string | undefined {
	// Tag-name checks instead of instanceof — cross-realm safe (iframe docs).
	const tag = el.tagName;
	if (tag === 'INPUT') {
		const input = el as HTMLInputElement;
		if (['hidden'].includes(input.type)) return undefined;
		if (['checkbox', 'radio'].includes(input.type)) return undefined;
		return input.value || undefined;
	}
	if (tag === 'TEXTAREA') return (el as HTMLTextAreaElement).value || undefined;
	if (tag === 'SELECT') return (el as HTMLSelectElement).value || undefined;
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
		if (match || kids.length > 0) {
			out.push({ ...n, children: match ? n.children : kids });
		}
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
		if (n.children.length > 0) {
			lines.push(renderText(n.children, depth + 1));
		}
	}
	return lines.filter((l) => l.length > 0).join('\n');
}

// --- selector / text resolution ------------------------------------------

export function resolveBySelector(selector: string, doc?: Document): Element | null {
	// With an explicit doc, search only it (pane-scoped resolution). Without
	// one, search the host document first, then every same-origin iframe doc
	// (pkg panes) so `iyke click --selector` reaches inside panes.
	const docs = doc ? [doc] : allSearchDocs();
	for (const d of docs) {
		try {
			const el = d.querySelector(selector);
			if (el) return el;
		} catch {
			return null; // invalid selector — same in every doc
		}
	}
	return null;
}

export function resolveByText(text: string, doc?: Document): Element | null {
	// Resolve against the *accessible name* the snapshot reports (aria-label /
	// aria-labelledby / alt / placeholder / text), not just visible text. Icon-
	// only controls — the whole activity bar, theme toggle, many toolbar buttons
	// — are named purely by aria-label and have no text content, so a text-only
	// match could never reach them and callers were forced onto ephemeral refs.
	// Matching the name makes the snapshot's `name` field a stable click target.
	const needle = text.trim();
	if (!needle) return null;
	let exact: HTMLElement | null = null;
	let partial: HTMLElement | null = null;
	// With an explicit doc, search only it (pane-scoped resolution); otherwise
	// the host doc + every same-origin iframe doc, so pkg-pane targets resolve.
	for (const d of doc ? [doc] : allSearchDocs()) {
		// `[aria-label]` widens the set to those icon buttons; the role list keeps
		// custom interactive elements that aren't native button/a.
		const candidates = d.querySelectorAll<HTMLElement>(
			'button, a, summary, label, [aria-label], [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=switch], [role=radio]'
		);
		for (const el of Array.from(candidates)) {
			const name = (accessibleName(el) ?? '').trim();
			const txt = (el.innerText ?? el.textContent ?? '').trim();
			// Prefer an exact name/text hit; fall back to substring (the original
			// behaviour). On ties, prefer the innermost (most specific) element.
			if (name === needle || txt === needle) {
				if (!exact || (exact.contains(el) && el !== exact)) exact = el;
			} else if (name.includes(needle) || txt.includes(needle)) {
				if (!partial || (partial.contains(el) && el !== partial)) partial = el;
			}
		}
		// An exact hit in an earlier doc (host first) wins outright.
		if (exact) break;
	}
	return exact ?? partial;
}

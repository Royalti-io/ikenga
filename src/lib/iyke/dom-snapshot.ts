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
	if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return true;
	if (el.getAttribute('aria-hidden') === 'true') return false;
	const style = window.getComputedStyle(el as HTMLElement);
	if (style.display === 'none' || style.visibility === 'hidden') return false;
	// 0-size elements with no children. Allow size=0 for input[type=hidden]-style cases.
	if (el instanceof HTMLElement) {
		const rect = el.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0 && el.children.length === 0) {
			// Inputs with type=hidden are intentionally 0-size. Keep them in --all only.
			return false;
		}
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
	// For buttons + links + headings: use text content.
	const tag = el.tagName.toLowerCase();
	if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary'].includes(tag)) {
		const t = (el.textContent ?? '').trim();
		if (t) return t.length > 200 ? t.slice(0, 200) + '…' : t;
	}
	return undefined;
}

function elementValue(el: Element): string | undefined {
	if (el instanceof HTMLInputElement) {
		if (['hidden'].includes(el.type)) return undefined;
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

export function resolveBySelector(selector: string): Element | null {
	try {
		return document.querySelector(selector);
	} catch {
		return null;
	}
}

export function resolveByText(text: string): Element | null {
	// Find the smallest element whose innerText (trimmed) contains the text.
	const candidates = document.querySelectorAll<HTMLElement>(
		'button, a, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=switch], label'
	);
	let best: HTMLElement | null = null;
	for (const el of Array.from(candidates)) {
		const t = (el.innerText ?? el.textContent ?? '').trim();
		if (t.includes(text)) {
			if (!best || (best.contains(el) && el !== best)) {
				best = el;
			}
		}
	}
	return best;
}

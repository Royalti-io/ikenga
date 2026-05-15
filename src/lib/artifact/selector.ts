// Stable-ish CSS selector derivation for the Studio's comment-mode picker.
//
// Goal: given an `Element` inside the artifact iframe's document, produce a
// short CSS selector that:
//   - uniquely identifies the element within its document (so the engine
//     can find it again after a small rewrite),
//   - reads well in a chat chip (`section#sales > .row` beats
//     `body > div:nth-of-type(2) > div > div > div:nth-of-type(3)`),
//   - degrades gracefully when the element has no id and no useful classes.
//
// Strategy:
//   1. If the element has an id, return `tag#id`. ids are unique.
//   2. Else, find the nearest ancestor with an id and build a path from there
//      using `tag.classes` + `:nth-of-type(N)` as a disambiguator only when
//      multiple siblings match.
//   3. Else, walk to <body> using the same path style.
//
// Implementation note: the load-bearing logic operates over a stripped-down
// `SelectorNode` interface (`deriveSelectorFromNode`) so the heuristics are
// unit-testable without a DOM environment. The `deriveSelector` entry point
// is a thin adaptor that wraps a real DOM Element into that interface.

/** Maximum depth of selector segments we'll emit. Anything past this is
 * usually noise; the engine can re-derive context from surrounding HTML. */
const MAX_DEPTH = 6;

/** Minimal node shape used by the pure logic. Real DOM Elements are
 *  wrapped into this via `nodeFromElement` below. */
export interface SelectorNode {
	id: string;
	tagName: string; // lowercase
	classNames: readonly string[];
	parent: SelectorNode | null;
	/** All siblings (including self) under `parent`. For root nodes (no
	 *  parent) this should be a single-element array containing self. */
	parentChildren: readonly SelectorNode[];
}

export function deriveSelectorFromNode(node: SelectorNode | null): string {
	if (!node) return '';
	if (node.id) return `${node.tagName}#${node.id}`;

	const segments: string[] = [];
	let cursor: SelectorNode | null = node;

	for (let i = 0; i < MAX_DEPTH && cursor && cursor.tagName !== 'body'; i++) {
		segments.unshift(segmentFor(cursor));

		if (cursor.parent?.id) {
			segments.unshift(`${cursor.parent.tagName}#${cursor.parent.id}`);
			return segments.join(' > ');
		}
		cursor = cursor.parent;
	}

	if (cursor && cursor.tagName === 'body') {
		segments.unshift('body');
	}

	return segments.join(' > ');
}

function segmentFor(node: SelectorNode): string {
	const classes = classListFor(node);
	const base = classes.length > 0 ? `${node.tagName}.${classes.join('.')}` : node.tagName;

	const sameTagSiblings = node.parentChildren.filter((c) => c.tagName === node.tagName);
	if (sameTagSiblings.length <= 1) return base;
	const idx = sameTagSiblings.indexOf(node) + 1;
	return `${base}:nth-of-type(${idx})`;
}

// Class-name allowlist heuristic: keep semantic-looking names, drop
// utility classes that change with restyles (Tailwind-style `text-sm`,
// `flex`, etc.). The heuristic is intentionally loose — false-positive
// utility filters here just give us longer selectors, not wrong ones.
function classListFor(node: SelectorNode): string[] {
	return node.classNames.filter(isLikelySemantic).slice(0, 2);
}

const UTILITY_PREFIXES = [
	'text-',
	'bg-',
	'p-',
	'px-',
	'py-',
	'm-',
	'mx-',
	'my-',
	'border-',
	'rounded',
	'flex',
	'grid',
	'gap-',
	'w-',
	'h-',
	'min-',
	'max-',
	'shadow-',
	'opacity-',
	'hover:',
	'focus:',
	'sm:',
	'md:',
	'lg:',
	'xl:',
];

function isLikelySemantic(cls: string): boolean {
	if (!cls) return false;
	// Tailwind responsive/state prefixes (`sm:`, `hover:`, etc.) make it a
	// utility class regardless of the rest.
	if (cls.includes(':')) return false;
	// Any class starting with a known utility prefix is a utility — the rest
	// of the string is the token (`p-4`, `bg-amber-500`, `text-sm`, etc.) and
	// none of those are useful for selector identity.
	if (UTILITY_PREFIXES.some((p) => cls.startsWith(p))) return false;
	if (/^[a-z]+-\d+$/.test(cls)) return false; // text-12, py-2, etc.
	if (cls.length > 32) return false; // probably a hashed class
	return true;
}

/** DOM adaptor: convert an Element into the SelectorNode shape, then run
 *  the pure logic. The wrapping is shallow — we only materialise as many
 *  ancestors as the depth limit needs. */
export function deriveSelector(el: Element | null | undefined): string {
	if (!el) return '';
	return deriveSelectorFromNode(nodeFromElement(el));
}

function nodeFromElement(el: Element): SelectorNode {
	const parent = el.parentElement;
	const parentChildren: SelectorNode[] = parent
		? Array.from(parent.children).map((c) => shallowNode(c))
		: [];

	const self: SelectorNode = {
		id: el.id ?? '',
		tagName: el.tagName.toLowerCase(),
		classNames: Array.from(el.classList),
		parent: parent ? nodeFromElement(parent) : null,
		parentChildren:
			parentChildren.length > 0
				? parentChildren
				: [
						{
							id: el.id ?? '',
							tagName: el.tagName.toLowerCase(),
							classNames: Array.from(el.classList),
							parent: null,
							parentChildren: [],
						} as SelectorNode,
					],
	};
	return self;
}

/** Shallow wrapper used when materialising siblings — we only need their
 *  identity for indexing, not their full ancestor chain. */
function shallowNode(el: Element): SelectorNode {
	return {
		id: el.id ?? '',
		tagName: el.tagName.toLowerCase(),
		classNames: Array.from(el.classList),
		parent: null,
		parentChildren: [],
	} as SelectorNode;
}

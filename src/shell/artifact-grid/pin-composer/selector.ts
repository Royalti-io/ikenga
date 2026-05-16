// Stable CSS-selector generator for pin anchoring.
//
// Goal: turn a right-clicked Element into a string the iframe can re-query
// later (when Claude reads the pin via `mcp-iyke.pin_read`) and find the
// same node — even if the page is reloaded.
//
// Strategy (first match wins):
//   1. `#id` if the element has one (modulo characters CSS.escape rejects).
//   2. `tag.class1.class2:nth-of-type(N)` ascending up to <body>, where N is
//      the 1-indexed position among same-tag siblings. Stops at the first
//      ancestor with an id, which becomes the anchor.
//
// We intentionally avoid `:nth-child` (more brittle to DOM edits) and
// attribute selectors with text content (escaping nightmare). If two pins
// somehow resolve to the same selector, the artifact author's HTML had
// indistinguishable nodes — that's a stale-pin problem solved later.

/** Generate a CSS selector for `el` that, when re-queried against the same
 *  document, returns `el` (or its semantic successor after light edits).
 *  Returns `'body'` as a last-resort fallback. */
export function cssSelectorFor(el: Element): string {
	if (el.id && cssIdentOk(el.id)) {
		return `#${cssEscape(el.id)}`;
	}
	const parts: string[] = [];
	let cur: Element | null = el;
	const root = el.ownerDocument?.body ?? null;
	while (cur && cur !== root) {
		parts.unshift(segmentFor(cur));
		if (cur.id && cssIdentOk(cur.id)) {
			// Anchor on the nearest id'd ancestor; the path above it
			// doesn't matter once we have a unique #anchor.
			parts[0] = `#${cssEscape(cur.id)}`;
			break;
		}
		cur = cur.parentElement;
	}
	return parts.join(' > ') || 'body';
}

function segmentFor(el: Element): string {
	const tag = el.tagName.toLowerCase();
	const classes = (el.getAttribute('class') ?? '')
		.split(/\s+/)
		.filter((c) => c.length > 0 && cssIdentOk(c))
		.slice(0, 2) // cap at 2 — long Tailwind class lists explode the selector
		.map((c) => '.' + cssEscape(c))
		.join('');
	// Same-tag sibling index (1-based) lets us distinguish multiple
	// `<p>` or `<div>` peers without leaning on textual content.
	const parent = el.parentElement;
	if (!parent) return tag + classes;
	const sameTagSibs = Array.from(parent.children).filter(
		(c) => c.tagName === el.tagName
	);
	if (sameTagSibs.length === 1) return tag + classes;
	const idx = sameTagSibs.indexOf(el) + 1;
	return `${tag}${classes}:nth-of-type(${idx})`;
}

// Conservative ident filter: rejects anything CSS.escape would have to
// handle (whitespace, leading digits, control chars). Skipping those
// classes keeps the selector readable and avoids the escape-then-strip
// rountrip downstream.
function cssIdentOk(s: string): boolean {
	return /^[A-Za-z_][\w-]*$/.test(s);
}

function cssEscape(s: string): string {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
		return CSS.escape(s);
	}
	return s.replace(/["\\]/g, '\\$&');
}

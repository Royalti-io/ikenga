// Decide the directory the viewer's static server should be rooted at.
//
// `<iframe src>` resolves relative URLs against the iframe origin, so any
// `<link href="../foo">` / `<script src="../foo">` inside the HTML must be
// reachable under the served root. Naïvely serving the file's parent breaks
// shared-asset designs (`../_shared/tokens.css` etc.). We scan the HTML for
// the deepest `..` ascent in any link/script/img reference and serve from
// that ancestor instead.
//
// Returns `{ root, file }` — the root to pass to `viewer_serve` and the
// relative path (from that root) to append to the served URL.

import { dirname } from './path';

export interface RelativeRoot {
	root: string;
	file: string;
}

const REF_ATTR_RE = /(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;

export function pickViewerRoot(htmlPath: string, html: string): RelativeRoot {
	const fileDir = dirname(htmlPath);
	const fileName = htmlPath.slice(fileDir.length + 1);

	let maxAscent = 0;
	for (const m of html.matchAll(REF_ATTR_RE)) {
		const value = (m[1] ?? m[2] ?? '').trim();
		if (
			!value ||
			/^[a-z][a-z0-9+.-]*:/i.test(value) ||
			value.startsWith('//') ||
			value.startsWith('#') ||
			value.startsWith('/') ||
			value.startsWith('data:')
		) {
			continue;
		}
		const ascent = countLeadingAscent(value);
		if (ascent > maxAscent) maxAscent = ascent;
	}

	if (maxAscent === 0) {
		return { root: fileDir, file: fileName };
	}

	const dirSegments = fileDir.split('/').filter((s) => s.length > 0);
	const ascent = Math.min(maxAscent, dirSegments.length);
	const rootSegments = dirSegments.slice(0, dirSegments.length - ascent);
	const root = '/' + rootSegments.join('/');
	const fileSegments = dirSegments.slice(dirSegments.length - ascent).concat(fileName);
	const file = fileSegments.join('/');
	return { root, file };
}

function countLeadingAscent(value: string): number {
	let count = 0;
	let rest = value;
	while (rest.startsWith('../')) {
		count++;
		rest = rest.slice(3);
	}
	return count;
}

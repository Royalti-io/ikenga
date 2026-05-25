/**
 * xterm link provider for file paths.
 *
 * `WebLinksAddon` only linkifies `http(s)://` URLs. This provider adds clickable
 * *file paths* — so a `/tmp/out.png` or `src/foo.ts` printed by a command opens
 * in the artifact viewer pane, the same destination a path pill opens from chat.
 *
 * Detection is shared with the markdown renderer via `looksLikePath`
 * (`@/lib/paths/file-paths`) so the two surfaces never disagree about what's a
 * path. Resolution is the synchronous `resolvePath` (expand `~`, join relative
 * against the terminal's cwd); absolute paths — the common terminal case — pass
 * through untouched, so this works even in attach-mode where no cwd is known.
 *
 * Known limitation: column ranges are computed against the cell string, so a
 * line containing wide (CJK/emoji) glyphs *before* a path can offset the
 * underline by a cell. Paths themselves are ASCII, so the link text and click
 * target are always correct — only the highlight rectangle can drift.
 */

import type { IDisposable, ILink, Terminal } from '@xterm/xterm';
import { looksLikePath, resolvePath } from '@/lib/paths/file-paths';
import { usePaneStore } from '@/lib/panes/pane-store';

interface PathSpan {
	/** 1-based start column (inclusive). */
	startX: number;
	/** 1-based end column (inclusive). */
	endX: number;
	text: string;
}

/** Find path-shaped tokens in one rendered line, with their cell columns.
 *  Exported for unit testing. */
export function scanLineForPaths(line: string): PathSpan[] {
	const out: PathSpan[] = [];
	const re = /\S+/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
	while ((m = re.exec(line)) !== null) {
		let tok = m[0];
		let start = m.index; // 0-based offset of first char

		// Strip surrounding wrappers/punctuation a path is often embedded in:
		// `(…)`, `[…]`, `<…>`, quotes, and trailing sentence punctuation.
		while (tok.length > 0 && /^[([<'"`]/.test(tok)) {
			tok = tok.slice(1);
			start++;
		}
		let end = start + tok.length; // 0-based, exclusive

		// Trim a trailing `:line` / `:line:col` suffix (grep -n, stack traces)
		// if doing so leaves a real path.
		const colon = tok.match(/:\d+(?::\d+)?$/);
		if (colon && looksLikePath(tok.slice(0, tok.length - colon[0].length))) {
			const cut = colon[0].length;
			tok = tok.slice(0, tok.length - cut);
			end -= cut;
		}

		// Drop trailing closers/punctuation until the token is path-shaped.
		while (tok.length >= 3 && !looksLikePath(tok) && /[)\]>'"`.,;:]$/.test(tok)) {
			tok = tok.slice(0, -1);
			end--;
		}

		if (tok.length >= 3 && looksLikePath(tok)) {
			// cell columns are 1-based; char at offset `start` is column start+1,
			// and the last char (offset end-1) is column `end`.
			out.push({ startX: start + 1, endX: end, text: tok });
		}
	}
	return out;
}

/**
 * Register the file-path link provider on a terminal. Returns a disposable;
 * call it from the host's cleanup. `cwd` resolves relative paths (absolute /
 * `~` paths ignore it).
 */
export function registerPathLinks(term: Terminal, cwd?: string): IDisposable {
	return term.registerLinkProvider({
		provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
			const line = term.buffer.active.getLine(bufferLineNumber - 1);
			if (!line) {
				callback(undefined);
				return;
			}
			const text = line.translateToString(true);
			const spans = scanLineForPaths(text);
			if (spans.length === 0) {
				callback(undefined);
				return;
			}
			const links: ILink[] = spans.map((span) => ({
				text: span.text,
				range: {
					start: { x: span.startX, y: bufferLineNumber },
					end: { x: span.endX, y: bufferLineNumber },
				},
				decorations: { pointerCursor: true, underline: true },
				activate: () => {
					const resolved = resolvePath(span.text, cwd);
					const store = usePaneStore.getState();
					store.addTabBackground(store.focusedId, { kind: 'artifact', path: resolved });
				},
			}));
			callback(links);
		},
	});
}

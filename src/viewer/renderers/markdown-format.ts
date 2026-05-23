// Editor-side helpers for the markdown editor: selection-wrapping commands
// (driven through the live CodeMirror view) and an explicit whole-document
// formatter (remark round-trip). Both are deliberately separate from the
// renderer so the toolbar can stay a thin presentational shell.

import type { CodeEditorHandle } from '@ikenga/ui-lib';

/** The concrete CodeMirror `EditorView`, sourced from the editor handle so we
 *  don't take a direct dependency on `@codemirror/view`. */
export type MarkdownEditorView = NonNullable<ReturnType<CodeEditorHandle['view']>>;

/** Wrap the current selection in `before`/`after` markers (bold, italic,
 *  inline code). With no selection, drop the markers and park the cursor
 *  between them. */
export function wrapSelection(view: MarkdownEditorView, before: string, after = before): void {
	const { from, to } = view.state.selection.main;
	const selected = view.state.sliceDoc(from, to);
	view.dispatch({
		changes: { from, to, insert: `${before}${selected}${after}` },
		selection: selected
			? { anchor: from + before.length, head: from + before.length + selected.length }
			: { anchor: from + before.length },
	});
	view.focus();
}

/** Add `prefix` to every line touched by the selection, or strip it if every
 *  such line already has it (toggle). Used for headings, lists, quotes. */
export function toggleLinePrefix(view: MarkdownEditorView, prefix: string): void {
	const { from, to } = view.state.selection.main;
	const first = view.state.doc.lineAt(from).number;
	const last = view.state.doc.lineAt(to).number;
	const lines = [];
	for (let n = first; n <= last; n++) lines.push(view.state.doc.line(n));
	const allPrefixed = lines.every((l) => l.text.startsWith(prefix));
	view.dispatch({
		changes: lines.map((l) =>
			allPrefixed
				? { from: l.from, to: l.from + prefix.length, insert: '' }
				: { from: l.from, insert: prefix }
		),
	});
	view.focus();
}

/** Replace the selection with a markdown link, parking the cursor on the URL
 *  placeholder so it can be typed over immediately. */
export function insertLink(view: MarkdownEditorView): void {
	const { from, to } = view.state.selection.main;
	const text = view.state.sliceDoc(from, to) || 'text';
	const urlStart = from + 1 + text.length + 2; // after `[text](`
	view.dispatch({
		changes: { from, to, insert: `[${text}](url)` },
		selection: { anchor: urlStart, head: urlStart + 3 },
	});
	view.focus();
}

/** Normalize a whole document through remark (parse → stringify). Preserves
 *  YAML/TOML frontmatter and raw HTML; reflows lists/tables/emphasis to a
 *  consistent style. Heavy deps are dynamic-imported so they stay out of the
 *  viewer's main chunk and only load when the user clicks Format. */
export async function formatMarkdown(src: string): Promise<string> {
	const [
		{ unified },
		{ default: remarkParse },
		{ default: remarkStringify },
		{ default: remarkGfm },
		{ default: remarkFrontmatter },
	] = await Promise.all([
		import('unified'),
		import('remark-parse'),
		import('remark-stringify'),
		import('remark-gfm'),
		import('remark-frontmatter'),
	]);
	const file = await unified()
		.use(remarkParse)
		.use(remarkFrontmatter, ['yaml', 'toml'])
		.use(remarkGfm)
		.use(remarkStringify, {
			bullet: '-',
			fences: true,
			rule: '-',
			listItemIndent: 'one',
			resourceLink: true,
		})
		.process(src);
	return String(file).replace(/\n+$/, '\n');
}

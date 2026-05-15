// Classify ACP/chat tool_use events as "did the engine just write to this
// artifact's path?". Used by Studio's source-state synchroniser to detect
// engine-driven file edits and re-read the file into the source editor.
//
// Pure data → boolean — no React, no Tauri — so the heuristic is
// unit-testable without a DOM env.
//
// The engine adapter we ship (`com.ikenga.engine-claude-code`) wraps the
// Claude Code CLI, whose file-write tool surface is:
//   - `Write`     { file_path, content }
//   - `Edit`      { file_path, old_string, new_string, replace_all? }
//   - `MultiEdit` { file_path, edits: [...] }
// Older/alternate adapters may surface the same shape under different
// names (e.g. `write_file`, `edit_file`). We accept any of those.

const ARTIFACT_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
	'Write',
	'Edit',
	'MultiEdit',
	'write_file',
	'edit_file',
	'multi_edit',
]);

/** Minimal shape we care about. Real events carry more fields; we ignore
 *  them. `input` is `unknown` because the tool's argument schema isn't
 *  type-known at the chat layer. */
export interface ToolUseLike {
	kind: 'tool_use';
	id: string;
	name: string;
	input: unknown;
}

/** True iff `use` is a recognised file-write tool whose `file_path`
 *  argument equals `artifactPath`. */
export function isArtifactWriteToolUse(use: ToolUseLike, artifactPath: string): boolean {
	if (use.kind !== 'tool_use') return false;
	if (!ARTIFACT_WRITE_TOOL_NAMES.has(use.name)) return false;
	const input = use.input as { file_path?: unknown; path?: unknown } | null;
	if (!input || typeof input !== 'object') return false;
	const filePath = input.file_path ?? input.path;
	return typeof filePath === 'string' && filePath === artifactPath;
}

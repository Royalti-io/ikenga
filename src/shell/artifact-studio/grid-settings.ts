// Artifact-grid settings — global defaults + per-folder overrides.
//
// Backed by SQLite `settings_kv` via the existing settings_get/set Tauri
// commands. Layout:
//   artifact-grid.default-sink                  global default (auto|terminal|chi|clipboard)
//   artifact-grid.stack-mode                    global default (collapsed|expanded)
//   artifact-grid.folder.<path>.default-sink    per-folder override (or absent = follow global)
//   artifact-grid.folder.<path>.stack-mode      per-folder override
//   artifact-grid:show-resolved:<path>          unrelated; the Open|All filter (already in use)
//
// The per-folder keys use a `folder.<path>.` prefix to keep them
// distinguishable from any future top-level key without parsing the path.

import { settingsGet, settingsSet, type RouteSink } from '@/lib/tauri-cmd';

/**
 * Routing destination for pin clicks within an artifact-grid (or
 * Studio-loupe) pane. The value selects the default `commentRoute`
 * override for every pin click on the board.
 *
 * - `auto` — let the Rust dispatcher pick: active claude PTY when one
 *   exists, clipboard otherwise.
 * - `terminal` — always send to the active claude PTY (degrades to
 *   clipboard if none is live).
 * - `chi` — always spawn a headless one-off agent run for the pin.
 * - `clipboard` — always copy the rendered prompt for manual paste.
 *
 * The pre-WP-05 `sidepane` and `both` values are migrated to `clipboard` on
 * read: their only consumer was the removed side-pane Chat composer.
 */
export type DefaultSink = 'auto' | 'terminal' | 'chi' | 'clipboard';
export type StackMode = 'collapsed' | 'expanded';

export const GLOBAL_KEYS = {
	defaultSink: 'artifact-grid.default-sink',
	stackMode: 'artifact-grid.stack-mode',
} as const;

export function folderKey(path: string, leaf: 'default-sink' | 'stack-mode'): string {
	return `artifact-grid.folder.${path}.${leaf}`;
}

/** Parse a persisted `default-sink` value, migrating retired ones. Exported
 *  so the settings route reads the same values the grid writes — a private
 *  copy here previously silently coerced `chi`/`clipboard` back to `auto`. */
export function parseDefaultSink(raw: string | null): DefaultSink | null {
	if (raw === 'auto' || raw === 'terminal' || raw === 'chi' || raw === 'clipboard') return raw;
	// Legacy values persisted before WP-05 dropped the chat surface. Both
	// targeted the side-pane Chat composer, which no longer exists; clipboard
	// is the closest surviving "don't touch my terminal" behaviour.
	if (raw === 'sidepane' || raw === 'both') return 'clipboard';
	return null;
}

function parseStackMode(raw: string | null): StackMode | null {
	if (raw === 'collapsed' || raw === 'expanded') return raw;
	return null;
}

export interface ArtifactGridSettings {
	globalDefaultSink: DefaultSink;
	globalStackMode: StackMode;
	folderDefaultSink: DefaultSink | null; // null = follow global
	folderStackMode: StackMode | null;
}

export async function loadSettings(path: string): Promise<ArtifactGridSettings> {
	const [globalSinkRaw, globalStackRaw, folderSinkRaw, folderStackRaw] = await Promise.all([
		settingsGet(GLOBAL_KEYS.defaultSink),
		settingsGet(GLOBAL_KEYS.stackMode),
		settingsGet(folderKey(path, 'default-sink')),
		settingsGet(folderKey(path, 'stack-mode')),
	]);
	return {
		globalDefaultSink: parseDefaultSink(globalSinkRaw) ?? 'auto',
		globalStackMode: parseStackMode(globalStackRaw) ?? 'collapsed',
		folderDefaultSink: parseDefaultSink(folderSinkRaw),
		folderStackMode: parseStackMode(folderStackRaw),
	};
}

export async function setGlobalDefaultSink(v: DefaultSink): Promise<void> {
	await settingsSet(GLOBAL_KEYS.defaultSink, v);
}

export async function setGlobalStackMode(v: StackMode): Promise<void> {
	await settingsSet(GLOBAL_KEYS.stackMode, v);
}

export async function setFolderDefaultSink(path: string, v: DefaultSink | null): Promise<void> {
	// We store an empty string as the "follow global" sentinel; settings_kv
	// has no delete API exposed to TS today, and an empty value reads back
	// as a non-matching raw which the parser treats as null/follow-global.
	await settingsSet(folderKey(path, 'default-sink'), v ?? '');
}

export async function setFolderStackMode(path: string, v: StackMode | null): Promise<void> {
	await settingsSet(folderKey(path, 'stack-mode'), v ?? '');
}

/** Effective default sink = folder override if set, else global, else auto. */
export function effectiveDefaultSink(s: ArtifactGridSettings): DefaultSink {
	return s.folderDefaultSink ?? s.globalDefaultSink;
}

/** Effective stack mode = folder override if set, else global, else collapsed. */
export function effectiveStackMode(s: ArtifactGridSettings): StackMode {
	return s.folderStackMode ?? s.globalStackMode;
}

/** Translate the effective default sink into the `overrideSink` argument
 *  the commentRoute Tauri command expects. `auto` returns undefined so
 *  the Rust dispatcher's existing PTY auto-detect runs. */
export function defaultSinkAsOverride(s: DefaultSink): RouteSink | undefined {
	if (s === 'auto') return undefined;
	return s;
}

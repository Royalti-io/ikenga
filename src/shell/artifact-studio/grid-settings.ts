// Artifact-grid settings — global defaults + per-folder overrides.
//
// Backed by SQLite `settings_kv` via the existing settings_get/set Tauri
// commands. Layout:
//   artifact-grid.default-sink                  global default (auto|terminal|sidepane)
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
 *   exists, side-pane Chat otherwise.
 * - `terminal` — always send to the active claude PTY (fallback to
 *   side-pane if none).
 * - `sidepane` — always emit to the side-pane Chat channel.
 * - `both` — mirror mode: every pin click fans out to terminal *and*
 *   side-pane simultaneously. Useful when you want claude to see the
 *   structured payload while also keeping the side-pane thread as a
 *   user-facing audit log.
 */
export type DefaultSink = 'auto' | 'terminal' | 'sidepane' | 'both';
export type StackMode = 'collapsed' | 'expanded';

export const GLOBAL_KEYS = {
	defaultSink: 'artifact-grid.default-sink',
	stackMode: 'artifact-grid.stack-mode',
} as const;

export function folderKey(path: string, leaf: 'default-sink' | 'stack-mode'): string {
	return `artifact-grid.folder.${path}.${leaf}`;
}

function parseDefaultSink(raw: string | null): DefaultSink | null {
	if (raw === 'auto' || raw === 'terminal' || raw === 'sidepane' || raw === 'both') return raw;
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

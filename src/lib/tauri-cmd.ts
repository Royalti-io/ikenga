// Typed wrappers around Tauri commands. This file is the cross-team contract
// between rust-eng (implements the commands in src-tauri/) and frontend-shell
// (consumes them from React). Keep in sync with src-tauri/src/commands/.
//
// Phase 1 surface area: pty (already implemented in spike), fs (read / list /
// watch), secrets (Stronghold), db (SQLite), viewer (axum localhost), and
// stubs for claude / chat / render that arrive in later phases. Stubs return
// `unimplemented!()` from Rust for phase 1 — the wrappers are typed today so
// later phases just fill in the Rust side.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ─── PTY ──────────────────────────────────────────────────────────────────────

export interface PtySpawnOpts {
	cwd: string;
	cmd: string[];
	env?: Record<string, string>;
	rows?: number;
	cols?: number;
}

export async function ptySpawn(opts: PtySpawnOpts): Promise<string> {
	return invoke<string>('pty_spawn', {
		cwd: opts.cwd,
		cmd: opts.cmd,
		env: opts.env ?? null,
		rows: opts.rows ?? 24,
		cols: opts.cols ?? 80,
	});
}

export async function ptyWrite(id: string, data: string): Promise<void> {
	return invoke('pty_write', { id, data });
}

export async function ptyResize(id: string, rows: number, cols: number): Promise<void> {
	return invoke('pty_resize', { id, rows, cols });
}

export async function ptyKill(id: string): Promise<void> {
	return invoke('pty_kill', { id });
}

/**
 * Subscribe to PTY byte stream + exit. Backend emits the data chunk as a
 * base64 string because Tauri's event system serializes payloads as JSON and
 * Uint8Array doesn't survive cleanly.
 */
export async function ptyListen(
	id: string,
	onData: (bytes: Uint8Array) => void,
	onExit: (code: number | null) => void
): Promise<UnlistenFn> {
	const dataUnlisten = await listen<string>(`pty://${id}`, (e) => {
		const bin = atob(e.payload);
		const arr = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
		onData(arr);
	});
	const exitUnlisten = await listen<number | null>(`pty://${id}/exit`, (e) => {
		onExit(e.payload);
	});
	return () => {
		dataUnlisten();
		exitUnlisten();
	};
}

// ─── FS ───────────────────────────────────────────────────────────────────────
//
// Scoped to allowlisted dirs (~/royalti-co, ~/.claude, ~/.company). Goes
// through the Rust side rather than tauri-plugin-fs directly so we can layer
// extra permission checks + mime detection.

export interface FileEntry {
	path: string;
	name: string;
	isDir: boolean;
	size: number;
	modifiedMs: number;
}

export interface FileChange {
	kind: 'create' | 'modify' | 'remove' | 'rename';
	path: string;
}

export interface FileReadResult {
	bytes: number[];
	mime: string;
}

export async function fsRead(path: string): Promise<FileReadResult> {
	return invoke('fs_read', { path });
}

/** Cheap MIME lookup that doesn't read file contents. Used by the artifact
 * viewer's auto-router as a fallback when JS extension lookup misses. */
export async function fsMime(path: string): Promise<string> {
	return invoke('fs_mime', { path });
}

/** Cheap existence check — returns true if `path` resolves to a regular
 * file (not a directory). Allowlisted same as the other fs commands. */
export async function fsExists(path: string): Promise<boolean> {
	return invoke('fs_exists', { path });
}

export async function fsWrite(path: string, bytes: Uint8Array): Promise<void> {
	return invoke('fs_write', { path, bytes: Array.from(bytes) });
}

export async function fsList(dir: string, glob?: string): Promise<FileEntry[]> {
	return invoke('fs_list', { dir, glob: glob ?? null });
}

/** Move a file or directory to the OS trash (reversible). */
export async function fsTrash(path: string): Promise<void> {
	return invoke('fs_trash', { path });
}

/** Rename in place to a new basename. Returns the resolved destination path. */
export async function fsRename(from: string, toName: string): Promise<string> {
	return invoke('fs_rename', { from, toName });
}

/** Returns a watcher id; events emit on `fs://{watcherId}`. */
export async function fsWatch(path: string): Promise<string> {
	return invoke('fs_watch', { path });
}

export async function fsUnwatch(watcherId: string): Promise<void> {
	return invoke('fs_unwatch', { watcherId });
}

export async function fsListenWatch(
	watcherId: string,
	onChange: (change: FileChange) => void
): Promise<UnlistenFn> {
	return listen<FileChange>(`fs://${watcherId}`, (e) => onChange(e.payload));
}

// ─── Secrets (Stronghold) ─────────────────────────────────────────────────────

export async function secretsGet(key: string): Promise<string | null> {
	return invoke('secrets_get', { key });
}

export async function secretsSet(key: string, value: string): Promise<void> {
	return invoke('secrets_set', { key, value });
}

export async function secretsDelete(key: string): Promise<void> {
	return invoke('secrets_delete', { key });
}

export async function secretsListKeys(): Promise<string[]> {
	return invoke('secrets_list_keys');
}

export type VaultStatus = {
	available: boolean;
	keychainBackend: string;
	error: string | null;
};

export async function secretsVaultStatus(): Promise<VaultStatus> {
	// Rust returns snake_case `keychain_backend`; normalize.
	const raw = await invoke<{ available: boolean; keychain_backend: string; error: string | null }>(
		'secrets_vault_status'
	);
	return {
		available: raw.available,
		keychainBackend: raw.keychain_backend,
		error: raw.error,
	};
}

export type ImportDotenvArgs = {
	paths: string[];
	keys: string[];
	overwrite: boolean;
};

export type ImportDotenvResult = {
	imported: number;
	skipped: number;
	missingFiles: string[];
};

export async function secretsImportDotenv(args: ImportDotenvArgs): Promise<ImportDotenvResult> {
	const raw = await invoke<{ imported: number; skipped: number; missing_files: string[] }>(
		'secrets_import_dotenv',
		{ args }
	);
	return {
		imported: raw.imported,
		skipped: raw.skipped,
		missingFiles: raw.missing_files,
	};
}

// ─── Supabase project config (URL + anon key, stored as a non-secret JSON
// manifest at app_data_dir/supabase.json — see commands/supabase_config.rs).

export type SupabaseConfig = {
	url: string;
	anonKey: string;
	serviceRoleKey?: string | null;
};

export async function supabaseConfigGet(): Promise<SupabaseConfig | null> {
	const raw = await invoke<{
		url: string;
		anon_key: string;
		service_role_key?: string | null;
	} | null>('supabase_config_get');
	return raw
		? { url: raw.url, anonKey: raw.anon_key, serviceRoleKey: raw.service_role_key ?? null }
		: null;
}

export async function supabaseConfigSet(
	url: string,
	anonKey: string,
	serviceRoleKey?: string | null
): Promise<void> {
	return invoke('supabase_config_set', {
		url,
		anonKey,
		serviceRoleKey: serviceRoleKey ?? null,
	});
}

export async function supabaseConfigClear(): Promise<void> {
	return invoke('supabase_config_clear');
}

// ─── DB (SQLite — chat threads, layout state) ─────────────────────────────────
//
// Thin wrapper over tauri-plugin-sql. The plugin can be used directly via
// `import Database from '@tauri-apps/plugin-sql'` — these helpers exist for
// callers who don't want to manage the connection.

export type SqlValue = string | number | boolean | null | number[];

export async function dbQuery<T = unknown>(sql: string, params: SqlValue[] = []): Promise<T[]> {
	return invoke('db_query', { sql, params });
}

export async function dbExec(sql: string, params: SqlValue[] = []): Promise<void> {
	return invoke('db_exec', { sql, params });
}

// ─── Viewer (shared axum server, same-origin via Vite proxy / localhost-plugin)

export interface ViewerHandle {
	/** Shell-origin-relative URL prefix, e.g. `/__viewer/<token>/`. Append the
	 *  file path to get a full iframe `src`. Resolved against
	 *  `window.location.origin` so it works under both Vite (dev) and
	 *  localhost-plugin (prod). */
	url: string;
	/** Pass to `viewerStop` to release the mount. */
	token: string;
}

export async function viewerServe(rootDir: string): Promise<ViewerHandle> {
	return invoke('viewer_serve', { rootDir });
}

export async function viewerStop(token: string): Promise<void> {
	return invoke('viewer_stop', { token });
}

/** Bound port of the shared viewer server. `null` if start failed. */
export async function viewerPort(): Promise<number | null> {
	return invoke('viewer_port');
}

// ─── Claude sessions (phase 3) ────────────────────────────────────────────────
//
// Real implementation lives in src-tauri/src/commands/claude.rs and the
// shared `crate::claude` module. The two parsers (live PTY stream-json and
// on-disk session jsonl) emit the same `ChatEvent` discriminated union; the
// frontend listens on `claude://session/{sessionId}` for live, or calls
// `claudeReadJsonl` for replays.

export interface ClaudeOpts {
	prompt?: string;
	resumeSessionId?: string;
	permissionMode?: 'default' | 'auto' | 'plan' | 'bypassPermissions';
	model?: string;
	rows?: number;
	cols?: number;
}

export interface ClaudeSpawnResult {
	/** Placeholder uuid until the first SessionInit event arrives with the real
	 *  Claude Code session id. Use `claudeListenSession(sessionId, ...)` to
	 *  start receiving events under either id — the backend re-emits on both. */
	sessionId: string;
	ptyId: string;
}

export interface SessionSummary {
	sessionId: string;
	projectDir: string;
	startedAt: string;
	lastMessageAt: string | null;
	messageCount: number;
	title: string | null;
	model: string | null;
}

/** Discriminated union mirroring `crate::claude::event::ChatEvent`. The wire
 *  shape is `{ kind, ... }` — see Rust enum for the canonical contract. */
export type ChatEvent =
	| {
			kind: 'session_init';
			sessionId: string;
			model: string | null;
			cwd: string | null;
			permissionMode: string | null;
	  }
	| { kind: 'text'; delta: string }
	| { kind: 'thinking'; delta: string }
	| {
			kind: 'tool_use';
			id: string;
			name: string;
			input: unknown;
			parentToolUseId?: string;
	  }
	| {
			kind: 'tool_result';
			id: string;
			output: unknown;
			isError?: boolean;
			parentToolUseId?: string;
	  }
	| {
			kind: 'artifact';
			path: string;
			mime: string;
			producedBy?: string;
	  }
	| {
			kind: 'system_hook';
			hookEvent: string;
			name?: string;
			content?: unknown;
	  }
	| { kind: 'rate_limit'; info: unknown }
	| {
			kind: 'done';
			usage?: unknown;
			totalCostUsd?: number;
			stopReason?: string;
			durationMs?: number;
	  }
	| { kind: 'unknown'; raw: unknown }
	| { kind: 'parse_error'; message: string; line: string };

export async function claudeSpawnSession(
	cwd: string,
	opts: ClaudeOpts
): Promise<ClaudeSpawnResult> {
	return invoke('claude_spawn_session', { cwd, opts });
}

/**
 * Spawn a streaming-input claude child (one long-lived process per chat
 * thread). Uses pipes, NOT a PTY — claude rejects stream-json over a TTY.
 * Returns a placeholder session id; the real id arrives via the first
 * `system:init` event on `claude://session/{placeholder}` and
 * `claude://session/{realId}`. `pty_id` in the result is empty for streaming
 * sessions — use `sessionId` for `claudeChatSend` / `claudeChatKill`.
 *
 * Multi-turn pattern: first call `claudeChatSpawn(cwd, { prompt, ... })`,
 * then `claudeChatSend(sessionId, text)` for each subsequent message.
 */
export async function claudeChatSpawn(cwd: string, opts: ClaudeOpts): Promise<ClaudeSpawnResult> {
	return invoke('claude_chat_spawn', { cwd, opts });
}

/** Send a follow-up user message to a live streaming child via stdin. */
export async function claudeChatSend(sessionId: string, text: string): Promise<void> {
	return invoke('claude_chat_send', { sessionId, text });
}

/** Kill a streaming child. Idempotent. */
export async function claudeChatKill(sessionId: string): Promise<void> {
	return invoke('claude_chat_kill', { sessionId });
}

/** Pass `null` or omit `projectDir` to list sessions across all project
 *  slugs under `~/.claude/projects/`. `limit` caps the number of summaries
 *  returned (sorted newest-first); omit for "all sessions" (slow with 9k+
 *  files on disk — prefer paging the UI instead). */
export async function claudeListSessions(
	projectDir?: string | null,
	limit?: number | null
): Promise<SessionSummary[]> {
	return invoke('claude_list_sessions', {
		projectDir: projectDir ?? null,
		limit: limit ?? null,
	});
}

export async function claudeReadJsonl(sessionId: string): Promise<ChatEvent[]> {
	return invoke('claude_read_jsonl', { sessionId });
}

/** Subscribe to parsed events for a live session. Returns the unlisten fn. */
export async function claudeListenSession(
	sessionId: string,
	onEvent: (event: ChatEvent) => void
): Promise<UnlistenFn> {
	return listen<ChatEvent>(`claude://session/${sessionId}`, (e) => onEvent(e.payload));
}

// ─── Claude config browser (/claude route) ────────────────────────────────────
//
// Read-only scan of `.claude/{agents,skills,commands}` and `.claude/settings*.json`
// across user-managed project roots + the personal `~/.claude/` dir. Backed by
// `commands/claude_config.rs` which uses `serde_yaml` to parse frontmatter and
// reuses `FsWatchManager` for live updates.

export type ClaudeConfigScope = 'project' | 'personal';

export interface ClaudeFrontmatter {
	[key: string]: unknown;
}

export interface ClaudeAgent {
	name: string;
	scope: ClaudeConfigScope;
	projectRoot: string | null;
	path: string;
	modifiedMs: number;
	description: string | null;
	model: string | null;
	frontmatter: ClaudeFrontmatter;
	body: string;
	overriddenBy: string | null;
}

export interface ClaudeSupportingFile {
	name: string;
	path: string;
	size: number;
}

export interface ClaudeSkill {
	name: string;
	scope: ClaudeConfigScope;
	projectRoot: string | null;
	path: string;
	dirPath: string;
	modifiedMs: number;
	description: string | null;
	frontmatter: ClaudeFrontmatter;
	body: string;
	supportingFiles: ClaudeSupportingFile[];
	overriddenBy: string | null;
}

export interface ClaudeCommand {
	name: string;
	scope: ClaudeConfigScope;
	projectRoot: string | null;
	path: string;
	modifiedMs: number;
	description: string | null;
	model: string | null;
	argumentHint: string | null;
	frontmatter: ClaudeFrontmatter;
	body: string;
	overriddenBy: string | null;
}

export interface ClaudeMcp {
	name: string;
	scope: ClaudeConfigScope;
	projectRoot: string | null;
	path: string;
	transport: 'stdio' | 'http' | 'sse' | 'unknown' | string;
	command: string | null;
	args: string[];
	envKeys: string[];
	url: string | null;
	headerKeys: string[];
	raw: unknown;
}

export interface ClaudeHook {
	event: string;
	type: string;
	name: string;
	scope: ClaudeConfigScope;
	projectRoot: string | null;
	settingsPath: string;
	commandPath: string | null;
	commandRaw: string | null;
	raw: unknown;
}

export interface ClaudeConfigScanError {
	path: string;
	message: string;
}

export interface ClaudeConfig {
	agents: ClaudeAgent[];
	skills: ClaudeSkill[];
	commands: ClaudeCommand[];
	hooks: ClaudeHook[];
	mcps: ClaudeMcp[];
	errors: ClaudeConfigScanError[];
}

export async function claudeConfigLoad(projectRoots: string[]): Promise<ClaudeConfig> {
	return invoke<ClaudeConfig>('claude_config_load', { projectRoots });
}

export async function claudeConfigWatch(projectRoots: string[]): Promise<string[]> {
	return invoke<string[]>('claude_config_watch', { projectRoots });
}

export async function claudeConfigUnwatch(watcherIds: string[]): Promise<void> {
	return invoke('claude_config_unwatch', { watcherIds });
}

export async function claudeConfigReadFile(path: string): Promise<string> {
	return invoke<string>('claude_config_read_file', { path });
}

/** Subscribe to any change under any watched .claude/ dir. The Rust watcher
 *  emits per-watcher events (`fs://{id}`); this helper subscribes to all of
 *  them and debounces invalidation so the consumer can simply call
 *  `queryClient.invalidateQueries({queryKey:['claude-config']})`.
 */
export async function claudeConfigListen(
	watcherIds: string[],
	onChange: () => void
): Promise<UnlistenFn> {
	const unlisteners = await Promise.all(
		watcherIds.map((id) => listen<unknown>(`fs://${id}`, () => onChange()))
	);
	return () => {
		for (const u of unlisteners) u();
	};
}

// ─── Iyke (phase 11 — Day 1: read-side state + shell mirror push) ─────────────

export interface IykeEndpoint {
	url: string;
	token: string;
	port: number;
}

export async function iykeEndpoint(): Promise<IykeEndpoint> {
	return invoke('iyke_endpoint');
}

export async function iykeSetShell(args: {
	mode?: string | null;
	route?: string | null;
}): Promise<void> {
	return invoke('iyke_set_shell', {
		mode: args.mode ?? null,
		route: args.route ?? null,
	});
}

// ─── Screenshots ──────────────────────────────────────────────────────────────

export interface ScreenshotResult {
	path: string;
	width: number;
	height: number;
	bytesLen: number;
}

export async function screenshotWindow(outPath?: string): Promise<ScreenshotResult> {
	return invoke('screenshot_window', { outPath: outPath ?? null });
}

export async function screenshotPane(paneId: string, outPath?: string): Promise<ScreenshotResult> {
	return invoke('screenshot_pane', {
		paneId,
		outPath: outPath ?? null,
	});
}

export interface ScreenshotConfig {
	/** User-supplied override (raw, may contain `~`). `null` = use platform default. */
	overrideDir: string | null;
	/** Per-platform default, absolute path. */
	defaultDir: string;
	/** What `capture()` will actually use right now. Tilde-expanded. */
	effectiveDir: string;
}

export async function screenshotGetConfig(): Promise<ScreenshotConfig> {
	return invoke('screenshot_get_config');
}

/** Pass `null` (or omit) to clear the override and revert to the platform default. */
export async function screenshotSetDir(dir: string | null): Promise<void> {
	return invoke('screenshot_set_dir', { dir: dir ?? null });
}

// ─── Spike: dynamic ACL verification (delete after kernel lands) ─────────

export async function spikeGrantFsRead(capabilityId: string, path: string): Promise<string> {
	return invoke<string>('spike_grant_fs_read', { capabilityId, path });
}

// ─── Pkg kernel ────────────────────────────────────────────────────────

/**
 * Provenance for an installed pkg. Recorded at install time by the kernel
 * and surfaced here so the UI can group / badge / gate uninstall on the
 * same source-of-truth that the kernel uses to enforce policy.
 *
 * Wire format mirrors `src-tauri/src/pkg/source.rs::InstallSource` —
 * `{kind}` plus per-variant fields. Keep in sync with that file.
 */
export type PkgInstallSource =
	| { kind: 'builtin' }
	| { kind: 'registry'; url: string; publisher_key: string | null }
	| { kind: 'local'; path: string };

export interface PkgInstalledSummary {
	id: string;
	version: string;
	ikenga_api: string;
	install_path: string;
	enabled: boolean;
	installed_at: number;
	compatible: boolean;
	source: PkgInstallSource;
}

export interface PkgKernelStatus {
	installed: PkgInstalledSummary[];
	registries: Record<string, unknown>;
	api_version: number;
}

export async function pkgInstallFromPath(
	installPath: string
): Promise<{ installed: PkgInstalledSummary }> {
	return invoke('pkg_install_from_path', { installPath });
}

export async function pkgUninstall(pkgId: string): Promise<void> {
	return invoke('pkg_uninstall', { pkgId });
}

export async function pkgSetEnabled(pkgId: string, enabled: boolean): Promise<void> {
	return invoke('pkg_set_enabled', { pkgId, enabled });
}

export async function pkgKernelStatus(): Promise<PkgKernelStatus> {
	return invoke<PkgKernelStatus>('pkg_kernel_status');
}

export interface PkgDiscovered {
	id: string;
	name: string;
	version: string;
	install_path: string;
	valid: boolean;
	error: string | null;
	installed: boolean;
	compatible: boolean;
}

/**
 * Dev-mode helper: scan a workspace directory for sibling pkgs without
 * installing anything. Pass `workspaceDir` explicitly, or omit to fall back
 * to the `IKENGA_WORKSPACE_DIR` env var on the Rust side. Returns an empty
 * list when neither is set.
 */
export async function pkgDiscoverWorkspace(workspaceDir?: string): Promise<PkgDiscovered[]> {
	return invoke<PkgDiscovered[]>('pkg_discover_workspace', { workspaceDir });
}

/**
 * Restart a supervised pkg's sidecar. Resets Blocked / Crashed / Parked
 * back to Spawning and breaks any pending retry sleep so the supervisor
 * re-spawns immediately. Returns true if the pkg is supervised here, false
 * if no supervisor entry exists for that id (per-call lifecycle pkgs).
 */
export async function pkgSupervisorRestart(pkgId: string): Promise<boolean> {
	return invoke<boolean>('pkg_supervisor_restart', { pkgId });
}

/**
 * Debug-only: pre-bind a port so the smoke route can verify the supervised
 * sidecar transitions to Blocked when its dev-server child sees EADDRINUSE.
 * Pair with `devReleasePort(token)` to free the port and observe recovery.
 * Release builds reject with an error.
 */
export async function devBindPort(port: number): Promise<number> {
	return invoke<number>('dev_bind_port', { port });
}

export async function devReleasePort(token: number): Promise<boolean> {
	return invoke<boolean>('dev_release_port', { token });
}

export interface PkgDbDiag {
	db_path: string;
	pkg_installed_count: number;
	ids: string[];
}

export async function pkgDbDiag(): Promise<PkgDbDiag> {
	return invoke<PkgDbDiag>('pkg_db_diag');
}

export interface PkgSettingsField {
	key: string;
	type: string;
	label: string;
	default?: unknown;
	description?: string | null;
}

export interface PkgSettingsSnapshot {
	pkg_id: string;
	/** Array of declared fields, or null if the pkg has no settings block. */
	schema: PkgSettingsField[] | null;
	/** Object of `{ key: parsed_value }` pulled from `pkg_settings`. */
	values: Record<string, unknown>;
}

export async function pkgSettingsGet(pkgId: string): Promise<PkgSettingsSnapshot> {
	return invoke<PkgSettingsSnapshot>('pkg_settings_get', { pkgId });
}

export async function pkgSettingsSet(pkgId: string, key: string, value: unknown): Promise<void> {
	return invoke('pkg_settings_set', { pkgId, key, value });
}

/** Parsed manifest as raw JSON. Includes whatever optional blocks the
 *  manifest declared: permissions, settings, mcp, sidecars, ui, etc. */
export interface PkgManifestPreview {
	id: string;
	name: string;
	version: string;
	ikenga_api: string;
	kind?: string | null;
	permissions?: Record<string, unknown>;
	settings?: { schema?: PkgSettingsField[] };
	mcp?: Array<{ name: string; command: string; args?: string[] }>;
	sidecars?: Array<{ name: string; bin: string }>;
	cron?: Array<{ id: string; expr: string; handler: string }>;
	ui?: { routes?: Array<{ path: string; kind: string; source: string }> };
	skills?: string | null;
	commands?: string | null;
	agents?: string | null;
	[key: string]: unknown;
}

export async function pkgPreviewManifest(installPath: string): Promise<PkgManifestPreview> {
	return invoke<PkgManifestPreview>('pkg_preview_manifest', { installPath });
}

// ─── Pkg content (iframe mount) ─────────────────────────────────────────
//
// `pkgContentUrl` mints a per-iframe access token and returns the URL the
// iframe should load (already includes pkgId + token + trailing slash).
// Append the manifest's `ui.routes[].source` (e.g. `dist/index.html` →
// pass just the filename relative to dist) to construct the final src.
// `pkgContentRevoke` releases the token when the iframe unmounts.

export interface PkgContentHandle {
	url: string;
	token: string;
}

export async function pkgContentUrl(pkgId: string): Promise<PkgContentHandle> {
	return invoke<PkgContentHandle>('pkg_content_url', { pkgId });
}

// `pkgContentHtml` reads the iframe entry HTML from the pkg's dist/, mints
// an access token, and injects a `<base href>` so subresource loads resolve
// against `http://127.0.0.1:<port>/<pkgId>/<token>/`. The returned `html`
// is meant to be assigned to `<iframe srcdoc>` — that's the workaround for
// the documented WebKitGTK bug where iframe-document loads from any
// non-https origin (custom protocol or http loopback) get blocked even
// though subresource fetches succeed.
// See https://github.com/tauri-apps/tauri/issues/12767.
export interface PkgContentHtmlHandle {
	html: string;
	baseUrl: string;
	token: string;
	/** Resolved Supabase config when the pkg's manifest declared
	 *  `capabilities.supabase`. `null` when the pkg didn't declare it, or
	 *  declared it non-required and the vault has no keys. Pkgs that don't
	 *  declare the capability never see this field populated. */
	supabase: { url: string; anonKey: string } | null;
}

export async function pkgContentHtml(pkgId: string, source: string): Promise<PkgContentHtmlHandle> {
	return invoke<PkgContentHtmlHandle>('pkg_content_html', { pkgId, source });
}

export async function pkgContentRevoke(token: string): Promise<void> {
	return invoke('pkg_content_revoke', { token });
}

// ─── Pkg MCP tool routing ───────────────────────────────────────────────
//
// v1 stub. The host bridge calls this when the iframe fires an MCP
// `tools/call`. Returns `{ ok: false, error: "not_implemented" }` until
// the first sidecar-owning pkg lands; the protocol path is exercised
// end-to-end so spec compliance is testable now.

export interface PkgMcpCallResult {
	ok: boolean;
	error: string | null;
	result: unknown | null;
}

export async function pkgMcpCall(
	pkgId: string,
	tool: string,
	args: unknown
): Promise<PkgMcpCallResult> {
	return invoke<PkgMcpCallResult>('pkg_mcp_call', { pkgId, tool, args });
}

// ─── pkg sidecar invocation ───────────────────────────────────────────────────
//
// Invoke a package-declared sidecar binary one-shot. Counterpart to the
// `sidecars: [{ name, bin }]` manifest block. Returns captured stdout +
// stderr + exit_code. The pkg_id must own the named sidecar; cross-pkg
// invocations are rejected at the Rust side.
//
// Used by pkg iframes (via the AppBridge) and by the cron registry's
// `sidecar:<name> <sub>` handler.

export interface PkgSidecarCallResult {
	ok: boolean;
	error: string | null;
	stdout: string | null;
	stderr: string | null;
	exit_code: number | null;
	timed_out: boolean;
}

export async function pkgSidecarCall(
	pkgId: string,
	name: string,
	args: string[] = [],
	options: { stdin?: string; timeoutSecs?: number } = {}
): Promise<PkgSidecarCallResult> {
	return invoke<PkgSidecarCallResult>('pkg_sidecar_call', {
		pkgId,
		name,
		args,
		stdin: options.stdin ?? null,
		timeoutSecs: options.timeoutSecs ?? null,
	});
}

// ─── Iyke MCP info (settings panel) ───────────────────────────────────────────
//
// Resolves the absolute path of the bundled iyke-mcp binary so the settings
// panel can render a copy-to-clipboard MCP-client config snippet.

export interface IykeMcpInfo {
	// Absolute path the user should configure their MCP client against.
	path: string;
	// True when the binary actually exists at `path`.
	present: boolean;
	// "dev-tree" | "resource-dir" | "unknown" — surfaced for the help text.
	source: string;
}

export async function iykeMcpInfo(): Promise<IykeMcpInfo> {
	return invoke<IykeMcpInfo>('iyke_mcp_info');
}

// ─── Activity-bar pinning (user-level) ────────────────────────────────────────
//
// Two distinct domains:
//
//   * **Sections** are user-created groups for the pinned area of the
//     activity bar. Reserved ids (`system`, `settings`) are host-owned and
//     rejected by Rust.
//   * **Pins** are user pins of artifacts/routes/files/etc. They may belong
//     to a section (`sectionId`) or sit section-less (`null`). Reorder is
//     scoped to a single section — pass `''` (empty string) as `sectionId`
//     to the reorder command to mean "no section".

export type ActivityPinKind = 'artifact' | 'route' | 'file' | 'external' | 'pkg-route';

export interface ActivityPin {
	id: string;
	kind: ActivityPinKind;
	target: string;
	label: string;
	iconLucide: string | null;
	iconEmoji: string | null;
	sectionId: string | null;
	sortOrder: number;
	createdAt: string;
}

export interface ActivitySection {
	id: string;
	label: string;
	iconLucide: string | null;
	iconEmoji: string | null;
	sortOrder: number;
	createdAt: string;
}

export async function activityPinsList(): Promise<ActivityPin[]> {
	return invoke<ActivityPin[]>('activity_pins_list');
}

export async function activityPinsAdd(args: {
	kind: ActivityPinKind;
	target: string;
	label: string;
	iconLucide?: string | null;
	iconEmoji?: string | null;
	sectionId?: string | null;
}): Promise<ActivityPin> {
	return invoke<ActivityPin>('activity_pins_add', {
		kind: args.kind,
		target: args.target,
		label: args.label,
		iconLucide: args.iconLucide ?? null,
		iconEmoji: args.iconEmoji ?? null,
		sectionId: args.sectionId ?? null,
	});
}

export async function activityPinsRemove(id: string): Promise<void> {
	return invoke('activity_pins_remove', { id });
}

/** Reorder pins within a section. Pass `''` as `sectionId` for the
 *  section-less group. The Rust side validates non-empty ids. */
export async function activityPinsReorder(orderedIds: string[], sectionId: string): Promise<void> {
	return invoke('activity_pins_reorder', { orderedIds, sectionId });
}

export async function activitySectionsList(): Promise<ActivitySection[]> {
	return invoke<ActivitySection[]>('activity_sections_list');
}

export async function activitySectionsCreate(args: {
	id: string;
	label: string;
	iconLucide?: string | null;
	iconEmoji?: string | null;
}): Promise<ActivitySection> {
	return invoke<ActivitySection>('activity_sections_create', {
		id: args.id,
		label: args.label,
		iconLucide: args.iconLucide ?? null,
		iconEmoji: args.iconEmoji ?? null,
	});
}

export async function activitySectionsUpdate(args: {
	id: string;
	label?: string;
	/** `undefined` = leave unchanged. `null` = clear. `string` = set. */
	iconLucide?: string | null;
	iconEmoji?: string | null;
}): Promise<ActivitySection> {
	// Distinguish "not supplied" (don't touch the column) from "explicit null"
	// (clear it) by serializing both cases differently. Rust deserializes
	// `Option<Option<String>>`: outer None = leave, inner None = NULL.
	const payload: Record<string, unknown> = { id: args.id };
	if (args.label !== undefined) payload.label = args.label;
	if (Object.hasOwn(args, 'iconLucide')) {
		payload.iconLucide = args.iconLucide ?? null;
	}
	if (Object.hasOwn(args, 'iconEmoji')) {
		payload.iconEmoji = args.iconEmoji ?? null;
	}
	return invoke<ActivitySection>('activity_sections_update', payload);
}

export async function activitySectionsRemove(id: string): Promise<void> {
	return invoke('activity_sections_remove', { id });
}

// ─── Backup / restore ─────────────────────────────────────────────────────────
//
// Phase 2: SQLite + age-passphrase-encrypted secrets + installed-pkg list.
// Restore is stage-and-swap-on-boot. `backupImport` writes a staged db,
// optionally a chmod-0600 secrets-pending.json (decrypted at import-time),
// and a marker; the next app launch swaps pa.db before any pool opens, and
// replays staged secrets through the Stronghold-backed `bulk_set`.

export interface PkgEntry {
	id: string;
	version: string;
	enabled: boolean;
}

export type PathMode = 'raw' | 'tokenized' | 'bundled';

export interface PathWarning {
	table: string;
	column: string;
	value: string;
	reason: string;
}

export interface BackupManifest {
	format_version: number;
	schema_version: number;
	created_at: string;
	hostname: string;
	username: string;
	path_mode: PathMode;
	/** Export-time $HOME, present iff path_mode === "tokenized". */
	home_dir: string | null;
	has_secrets: boolean;
	pkg_count: number;
	path_warnings: PathWarning[];
}

export interface BackupSummary {
	path: string;
	created_at: string;
	size_bytes: number;
	schema_version: number;
	has_secrets: boolean;
	pkg_count: number;
	path_mode: PathMode;
}

export interface ExportResult {
	path: string;
	size_bytes: number;
	secrets_count: number;
	pkg_count: number;
	path_warnings_count: number;
}

export type SchemaAction =
	| { kind: 'match' }
	| { kind: 'forward'; from: number; to: number }
	| { kind: 'newer_than_app'; backup: number; app: number };

export interface ImportPreview {
	manifest: BackupManifest;
	size_bytes: number;
	schema_action: SchemaAction;
	pkgs: PkgEntry[];
}

export interface ImportResult {
	staged_at: string;
	requires_restart: boolean;
	secrets_staged: boolean;
}

export interface BackupExportOpts {
	/** When true, the bundle includes vault secrets encrypted with `passphrase`. */
	includeSecrets: boolean;
	/** Required when `includeSecrets` is true. */
	passphrase?: string;
	/** Defaults to "raw" on the Rust side. "bundled" is not yet implemented. */
	pathMode?: PathMode;
}

export async function backupExport(
	destPath: string,
	opts: BackupExportOpts
): Promise<ExportResult> {
	return invoke<ExportResult>('backup_export', {
		destPath,
		includeSecrets: opts.includeSecrets,
		passphrase: opts.passphrase ?? null,
		pathMode: opts.pathMode ?? null,
	});
}

export async function backupImport(
	srcPath: string,
	opts: { dryRun: boolean; passphrase?: string }
): Promise<ImportPreview | ImportResult> {
	return invoke('backup_import', {
		srcPath,
		dryRun: opts.dryRun,
		passphrase: opts.passphrase ?? null,
	});
}

export async function backupList(): Promise<BackupSummary[]> {
	return invoke<BackupSummary[]>('backup_list');
}

export async function backupDelete(path: string): Promise<void> {
	return invoke('backup_delete', { path });
}

// ─── First-run wizard: system + agent detection ──────────────────────────────
//
// Three commands the onboarding wizard calls once on mount. All return rich
// JSON so the wizard can render without a second round-trip. Field names
// stay snake_case to match the Rust serde output verbatim — easier to
// audit than a hand-mapped camelCase translation.

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface SystemCheck {
	id: string;
	level: CheckLevel;
	message: string;
	fix_hint: string | null;
}

export interface SystemReport {
	os: string;
	arch: string;
	disk_free_gb: number;
	app_data_dir: string;
	app_data_writable: boolean;
	vault_key_present: boolean;
	claude_projects_dir_present: boolean;
	checks: SystemCheck[];
}

export interface AgentCapabilities {
	streaming: boolean;
	tool_use: boolean;
	thinking: boolean;
	artifacts: boolean;
	mcp: boolean;
	session_resume: boolean;
}

export interface DetectedAgent {
	id: string;
	display: string;
	executable_path: string;
	version: string | null;
	/** null = unknown / not probed; true = authed; false = not authed. */
	authed: boolean | null;
	/** Human-readable hint when `authed === false` or probe was inconclusive. */
	auth_hint: string | null;
	capabilities: AgentCapabilities;
}

export interface AgentConfigInventory {
	root_path: string;
	config_dir_present: boolean;
	agent_count: number;
	skill_count: number;
	command_count: number;
	mcp_server_count: number;
	project_count: number;
}

export async function detectSystem(): Promise<SystemReport> {
	return invoke<SystemReport>('detect_system');
}

export async function detectAgents(): Promise<DetectedAgent[]> {
	return invoke<DetectedAgent[]>('detect_agents');
}

export async function detectAgentConfig(
	agentId: string,
	rootPath: string
): Promise<AgentConfigInventory> {
	return invoke<AgentConfigInventory>('detect_agent_config', {
		agentId,
		rootPath,
	});
}

// Light-weight scan of `~/.claude/projects/` so the roots step can seed
// suggestions. The slug→path decode is best-effort (Claude Code slugifies
// `/` → `-`, which is lossy for components with internal hyphens) — the
// wizard treats results as suggestions, not source-of-truth.
export interface ClaudeProjectEntry {
	slug: string;
	/** Best-effort decoded path. When `path_verified` is false this is
	 *  the naive `s/-/\//g` decode — the wizard should show it as a
	 *  guess the user can edit before adding. */
	path: string;
	display_path: string;
	session_count: number;
	last_modified_ms: number;
	/** True iff the Rust side could `metadata()` the decoded path. */
	path_verified: boolean;
}

export async function listClaudeProjects(): Promise<ClaudeProjectEntry[]> {
	return invoke<ClaudeProjectEntry[]>('list_claude_projects');
}

// Agent-config scaffolder (Phase 6). Lays down a starter set of
// agents/skills/commands for the given provider into `<rootPath>/.claude/`
// (or the provider's equivalent). `mode` mirrors the Rust ScaffoldMode:
//   - 'augment'        (default) — write only files that don't exist
//   - 'replace'                  — overwrite everything
//   - 'skip_conflicts'           — like augment but the response lists
//                                  every conflict-skipped path
export type ScaffoldAgentConfigMode = 'replace' | 'augment' | 'skip_conflicts';

export interface ScaffoldAgentConfigFileEntry {
	path: string;
	reason: string;
}

export interface ScaffoldAgentConfigResult {
	ok: boolean;
	files_written: number;
	message: string;
	written: string[];
	skipped: ScaffoldAgentConfigFileEntry[];
	errors: ScaffoldAgentConfigFileEntry[];
}

export async function scaffoldAgentConfig(
	provider: string,
	rootPath: string,
	profile: string,
	mode: ScaffoldAgentConfigMode = 'augment'
): Promise<ScaffoldAgentConfigResult> {
	return invoke<ScaffoldAgentConfigResult>('scaffold_agent_config', {
		provider,
		rootPath,
		profile,
		mode,
	});
}

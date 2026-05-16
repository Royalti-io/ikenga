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

/** Foreground process snapshot for a single PTY — what the user is actually
 *  running in the terminal right now (e.g. `claude`, `bash`, `vim`). Returns
 *  `null` when the PTY is gone or the platform doesn't yet surface it
 *  (macOS / Windows in v0). Cached for 1s per PTY in the Rust side. */
export interface ForegroundProcess {
	pid: number;
	/** Executable basename — e.g. `"claude"`, `"bash"`. */
	name: string;
	/** Full argv, null-byte-stripped. Empty when the kernel returned nothing. */
	args: string[];
}

export async function ptyForeground(id: string): Promise<ForegroundProcess | null> {
	return invoke<ForegroundProcess | null>('pty_foreground', { id });
}

/** Foreground snapshot across every live PTY. Keyed by PTY id; only PTYs
 *  whose foreground lookup succeeded appear in the result. The routing
 *  dispatcher uses this to pick the active claude session for pin delivery. */
export async function ptyForegroundSnapshot(): Promise<Record<string, ForegroundProcess>> {
	return invoke<Record<string, ForegroundProcess>>('pty_foreground_snapshot');
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
// Main-window plugin-fs is intentionally empty-scoped — `capabilities/default.json`
// lists the fs:* perm identifiers with empty allow arrays so no static main-window
// fs grant exists. All app fs goes through the Rust commands below (fsRead, fsList,
// etc.), which enforce a user-configured allowlist via `fs_roots::FsRoots` (Settings
// → Storage → File roots). Per-pkg fs is granted dynamically by the perms registry's
// `add_capability` at install time, independent of this file.

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

/** Cheap kind discriminator — returns `'file' | 'dir' | 'missing'` for an
 *  allowlisted path. Backs the unified artifact-studio route resolver
 *  (folder → grid density, file → loupe density). `'missing'` covers
 *  both not-found and allowlist-rejected. */
export async function fsKind(path: string): Promise<'file' | 'dir' | 'missing'> {
	return invoke('fs_kind', { path });
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

// ─── FS allowlist (user-configurable) ────────────────────────────────────────
//
// The allowlist is owned by Rust (`src-tauri/src/fs_roots.rs`, persisted to
// `app_data_dir/fs_roots.json`). Every mutation returns the canonical list so
// the frontend can sync from the response rather than maintaining a parallel
// store. Default roots: `~/royalti-co`, `~/.claude/projects`, `~/.company`.

export async function fsRootsList(): Promise<string[]> {
	return invoke('fs_roots_list');
}

export async function fsRootsAdd(path: string): Promise<string[]> {
	return invoke('fs_roots_add', { path });
}

export async function fsRootsRemove(path: string): Promise<string[]> {
	return invoke('fs_roots_remove', { path });
}

export async function fsRootsReset(): Promise<string[]> {
	return invoke('fs_roots_reset');
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

// ─── Settings KV (durable mirror for Zustand-persisted prefs) ───────────────
//
// Backed by SQLite `settings_kv` table (migration 0013). Zustand stores
// continue to write to localStorage for instant-paint hydration; this layer
// is the authoritative copy that survives "Clear local data" and can later
// feed a cross-device sync. See `useShellStore.hydrateSettingsFromRust`.
// Values are JSON strings — type discipline is enforced by callers.

export async function settingsGet(key: string): Promise<string | null> {
	return invoke('settings_get', { key });
}

export async function settingsSet(key: string, value: string): Promise<void> {
	return invoke('settings_set', { key, value });
}

export async function settingsGetAll(): Promise<Record<string, string>> {
	return invoke('settings_get_all');
}

export async function settingsClearAll(): Promise<void> {
	return invoke('settings_clear_all');
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

// ─── Phase 7 — scoped secrets ─────────────────────────────────────────────

/** Vault scope discriminator matching Rust's `commands::secrets::Scope`.
 *  Serde tags this enum with `kind` and snake-cases the variants, so the
 *  wire shape is `{ kind: "workspace" } | { kind: "project", id } | ...`. */
export type VaultScope =
	| { kind: 'workspace' }
	| { kind: 'project'; id: string }
	| { kind: 'pkg'; id: string };

export async function secretsGetScoped(scope: VaultScope, key: string): Promise<string | null> {
	return invoke('secrets_get_scoped', { scope, key });
}

export async function secretsSetScoped(
	scope: VaultScope,
	key: string,
	value: string
): Promise<void> {
	return invoke('secrets_set_scoped', { scope, key, value });
}

export async function secretsDeleteScoped(scope: VaultScope, key: string): Promise<void> {
	return invoke('secrets_delete_scoped', { scope, key });
}

export async function secretsListKeysScoped(scope: VaultScope): Promise<string[]> {
	return invoke('secrets_list_keys_scoped', { scope });
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
	| { kind: 'text'; delta: string; messageId?: string }
	| { kind: 'thinking'; delta: string; messageId?: string }
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
	| {
			/** Phase 4: claude emitted an `sdk_control_request` envelope —
			 *  today only the `permission` subtype is supported. The ACP
			 *  server forwards this as `session/request_permission`;
			 *  legacy chat consumers can ignore it. */
			kind: 'control_request';
			requestId: string;
			subtype: string;
			toolName?: string;
			toolInput?: unknown;
	  }
	| { kind: 'unknown'; raw: unknown }
	| { kind: 'parse_error'; message: string; line: string }
	/** Frontend-synthesized: a user message we wrote to the streaming child's
	 *  stdin. Persisted to `chat_user_turns` in SQLite (Claude's JSONL doesn't
	 *  record plain-string user messages). Never emitted by Rust. */
	| { kind: 'user_turn'; text: string; sequence: number; createdAt: number };

// ─── Session-as-object (thread_id-keyed) ──────────────────────────────────────
//
// `threadId` is a stable, frontend-minted uuid. Claude's session id and any
// PTY id are attributes of the Session. Events emit on `session://{threadId}`.
// The full implementation lives in `src-tauri/src/claude/session.rs`.

export interface SessionHandle {
	threadId: string;
	/** Populated once the parser has seen the first `system:init` event. */
	claudeSessionId: string | null;
}

/** Idempotently create / fetch a session. Does NOT spawn a process. The
 *  streaming child is lazy; first call to `sessionSend` spawns it (or
 *  `--resume`s an existing Claude session if `opts.resumeSessionId` is set). */
export async function sessionEnsure(
	threadId: string,
	cwd: string,
	opts: ClaudeOpts = {}
): Promise<SessionHandle> {
	return invoke('session_ensure', { threadId, cwd, opts });
}

/** Write a user message to the session's streaming child. Spawns one if
 *  absent, with `--resume <claudeSessionId>` so the conversation continues. */
export async function sessionSend(threadId: string, text: string): Promise<void> {
	return invoke('session_send', { threadId, text });
}

/** Submit a tool result back to Claude — used by interactive tool
 *  renderers like AskUserQuestion to ferry the user's answer into the
 *  agent loop. `output` is a JSON value (string or structured). */
export async function sessionToolResult(
	threadId: string,
	toolUseId: string,
	output: unknown,
	isError = false
): Promise<void> {
	return invoke('session_tool_result', { threadId, toolUseId, output, isError });
}

/** Kill the streaming child but keep the session row so the next send
 *  re-spawns. Idempotent. */
export async function sessionCancel(threadId: string): Promise<void> {
	return invoke('session_cancel', { threadId });
}

/** Tear down the session entirely (kill child + drop in-memory entry).
 *  Idempotent. */
export async function sessionDestroy(threadId: string): Promise<void> {
	return invoke('session_destroy', { threadId });
}

/** HMR / page-reload hygiene: kill every streaming child the app owns. Wire
 *  this to window 'beforeunload' so dev reloads don't leave zombies. */
export async function sessionDestroyAll(): Promise<void> {
	return invoke('session_destroy_all');
}

// ─── Chat threads scoped by project (Phase 3 of projects-first-class) ─────────
//
// Wire format mirrors `commands::claude::ChatThreadSummary` exactly — snake_case
// over the JSON wire because the Rust struct is serde-default. The /sessions
// page reads this list filtered by the shell's active project; the session-
// detail page calls `chatThreadMove` to retag a thread without restarting the
// claude subprocess (metadata-only — the captured cwd stays put).

export interface ChatThreadSummary {
	id: string;
	title: string | null;
	cwd: string | null;
	project_id: string | null;
	claude_session_id: string | null;
	created_at: number;
	updated_at: number;
}

export async function chatThreadsListByProject(
	projectId: string | null,
	includeAll = false,
	limit?: number | null
): Promise<ChatThreadSummary[]> {
	return invoke<ChatThreadSummary[]>('chat_threads_list_by_project', {
		projectId,
		includeAll,
		limit: limit ?? null,
	});
}

/** Reattribute a chat thread to a different project. Metadata-only —
 *  the in-memory `Session` and any live claude child keep the cwd they
 *  were spawned with. */
export async function chatThreadMove(threadId: string, projectId: string): Promise<void> {
	return invoke('chat_thread_move', { threadId, projectId });
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

/** Subscribe to parsed events for a live Claude session (PTY transports +
 *  legacy mirror for streaming sessions, keyed on the real Claude session
 *  id). For chat threads, prefer `sessionListen(threadId, ...)` — same id
 *  before and after `system:init`. */
export async function claudeListenSession(
	sessionId: string,
	onEvent: (event: ChatEvent) => void
): Promise<UnlistenFn> {
	return listen<ChatEvent>(`claude://session/${sessionId}`, (e) => onEvent(e.payload));
}

/** Subscribe to parsed events for a chat thread, keyed by its stable
 *  internal `threadId`. The Rust side emits on `session://{threadId}` for
 *  the full lifetime of the thread — no placeholder/real id swap. */
export async function sessionListen(
	threadId: string,
	onEvent: (event: ChatEvent) => void
): Promise<UnlistenFn> {
	return listen<ChatEvent>(`session://${threadId}`, (e) => onEvent(e.payload));
}

// ─── ACP (phase 3) ────────────────────────────────────────────────────────────
//
// Minimal local TS types that mirror the subset of the
// `@agentclientprotocol/sdk` schema we currently exchange with the Rust ACP
// server. We do NOT depend on the SDK here — that package is ~1.4 MB and we
// only need a handful of shapes. If we ever wire up an external ACP peer
// we'll re-export these from a shared package; phase 10 reshapes things.

/** ACP `ProtocolVersion`. Numeric. V1 = 1. */
export type AcpProtocolVersion = number;

export interface AcpClientCapabilities {
	fs?: { readTextFile?: boolean; writeTextFile?: boolean };
	terminal?: boolean;
}

export interface AcpInitializeRequest {
	protocolVersion: AcpProtocolVersion;
	clientCapabilities?: AcpClientCapabilities;
	_meta?: Record<string, unknown>;
}

export interface AcpPromptCapabilities {
	image: boolean;
	audio: boolean;
	embeddedContext: boolean;
}

export interface AcpMcpCapabilities {
	http: boolean;
	sse: boolean;
}

export interface AcpAgentCapabilities {
	loadSession: boolean;
	promptCapabilities: AcpPromptCapabilities;
	mcpCapabilities: AcpMcpCapabilities;
}

export interface AcpInitializeResponse {
	protocolVersion: AcpProtocolVersion;
	agentCapabilities: AcpAgentCapabilities;
	authMethods: unknown[];
	_meta?: Record<string, unknown>;
}

export interface AcpTextContentBlock {
	type: 'text';
	text: string;
}

/** ACP `ContentBlock::Image`. `data` is base64-encoded image bytes with NO
 *  `data:` URI prefix (composer paste/drop handlers strip it before
 *  building the block). `mimeType` deserializes natively on the Rust side
 *  because `agent_client_protocol::schema::ImageContent` is annotated
 *  `#[serde(rename_all = "camelCase")]` — no boundary translation needed.
 *  Phase 7 made this content block end-to-end functional. */
export interface AcpImageContentBlock {
	type: 'image';
	data: string;
	mimeType: string;
	uri?: string;
}

export type AcpContentBlock =
	| AcpTextContentBlock
	| AcpImageContentBlock
	| { type: 'audio'; data: string; mimeType: string }
	| { type: 'resource_link'; name: string; uri: string }
	| { type: 'resource'; resource: unknown };

export interface AcpNewSessionRequest {
	cwd: string;
	mcpServers: unknown[];
	_meta?: Record<string, unknown>;
}

/** Phase 5: the four canonical ACP session modes the Rust ACP server
 *  advertises. Mapping to claude CLI flags lives in `acp::mode` —
 *  `auto` translates to claude's `acceptEdits`, everything else passes
 *  through unchanged. */
export type AcpSessionModeId = 'plan' | 'default' | 'auto' | 'bypassPermissions';

export interface AcpSessionMode {
	id: AcpSessionModeId;
	name: string;
	description?: string;
	_meta?: Record<string, unknown>;
}

/** Mirrors ACP `SessionModeState`. The Rust server populates this on every
 *  `session/new` response so the frontend can render a mode picker. */
export interface AcpSessionModes {
	currentModeId: AcpSessionModeId;
	availableModes: AcpSessionMode[];
	_meta?: Record<string, unknown>;
}

export interface AcpNewSessionResponse {
	sessionId: string;
	modes?: AcpSessionModes;
	models?: unknown;
	configOptions?: unknown[];
	_meta?: Record<string, unknown>;
}

export interface AcpPromptRequest {
	sessionId: string;
	prompt: AcpContentBlock[];
	messageId?: string;
	_meta?: Record<string, unknown>;
}

export type AcpStopReason =
	| 'end_turn'
	| 'max_tokens'
	| 'max_turn_requests'
	| 'refusal'
	| 'cancelled';

export interface AcpPromptResponse {
	stopReason: AcpStopReason;
	userMessageId?: string;
	usage?: unknown;
	_meta?: Record<string, unknown>;
}

/** ACP `SessionUpdate` discriminated union. We only enumerate the variants
 *  the Rust mapper currently emits — extend as later phases land. */
export type AcpSessionUpdate =
	| { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock; messageId?: string }
	| { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock; messageId?: string }
	| { sessionUpdate: 'user_message_chunk'; content: AcpContentBlock }
	| {
			sessionUpdate: 'tool_call';
			toolCallId: string;
			title: string;
			kind?: string;
			status?: string;
			content?: unknown[];
			rawInput?: unknown;
			_meta?: Record<string, unknown>;
	  }
	| {
			sessionUpdate: 'tool_call_update';
			toolCallId: string;
			fields: {
				status?: string;
				content?: unknown[];
				rawOutput?: unknown;
			};
			_meta?: Record<string, unknown>;
	  }
	| { sessionUpdate: string; [k: string]: unknown };

export interface AcpSessionNotification {
	sessionId: string;
	update: AcpSessionUpdate;
	_meta?: Record<string, unknown>;
}

/** ACP `initialize` — handshake. Returns the negotiated protocol version
 *  + the agent's advertised capabilities. */
export async function acpInitialize(req: AcpInitializeRequest): Promise<AcpInitializeResponse> {
	return invoke<AcpInitializeResponse>('acp_initialize', { req });
}

/** ACP `session/new` — mints a fresh thread id keyed in Rust as both the
 *  ACP `sessionId` and the legacy `threadId`. The claude child is lazy —
 *  it spawns on the first `acpPrompt`. */
export async function acpNewSession(req: AcpNewSessionRequest): Promise<AcpNewSessionResponse> {
	return invoke<AcpNewSessionResponse>('acp_new_session', { req });
}

/** ACP `session/prompt` — synchronous from the caller's POV, but emits
 *  `AcpSessionNotification`s on `acp://session/{sessionId}` while the
 *  agent is mid-turn. The promise resolves when the turn ends. */
export async function acpPrompt(req: AcpPromptRequest): Promise<AcpPromptResponse> {
	return invoke<AcpPromptResponse>('acp_prompt', { req });
}

/** ACP `session/cancel`. Phase 6: now uses a clean interrupt envelope
 *  instead of killing the child — the Rust side writes
 *  `sdk_control_request { subtype: "interrupt" }` to claude's stdin and
 *  claude stops mid-turn while emitting its normal `Done` event. The
 *  transcript stays intact and the streaming child stays alive, so the
 *  next prompt re-uses it instead of paying spawn cost. Best-effort: a
 *  stale or unknown `threadId` resolves cleanly as a no-op. */
export async function acpCancel(threadId: string): Promise<void> {
	return invoke('acp_cancel', { threadId });
}

/** Subscribe to ACP session updates for a given thread. Tauri side emits
 *  `AcpSessionNotification`s on `acp://session/{threadId}` for every
 *  `SessionUpdate` derived from the underlying ChatEvent stream. */
export async function acpListen(
	threadId: string,
	onUpdate: (notification: AcpSessionNotification) => void
): Promise<UnlistenFn> {
	return listen<AcpSessionNotification>(`acp://session/${threadId}`, (e) => onUpdate(e.payload));
}

// ─── ACP permission round-trip (phase 4) ──────────────────────────────────────
//
// Subset of the ACP `session/request_permission` request/response shapes we
// care about today. The Rust side emits the full request payload through
// `acp://session/{threadId}/request`; the client replies via
// `acpRespondPermission`. See `src-tauri/src/acp/permission.rs` for the
// option-id encoding (`ask:{q_idx}:{label}` for AskUserQuestion, the four
// canonical `allow_once / allow_always / reject_once / reject_always` for
// generic tools).

export type AcpPermissionOptionKind =
	| 'allow_once'
	| 'allow_always'
	| 'reject_once'
	| 'reject_always';

export interface AcpPermissionOption {
	optionId: string;
	name: string;
	kind: AcpPermissionOptionKind;
}

export interface AcpToolCallUpdate {
	toolCallId: string;
	title?: string;
	kind?: string;
	status?: string;
	content?: unknown[];
	rawInput?: unknown;
	rawOutput?: unknown;
}

export interface AcpRequestPermissionRequest {
	sessionId: string;
	toolCall: AcpToolCallUpdate;
	options: AcpPermissionOption[];
	_meta?: Record<string, unknown>;
}

export type AcpRequestPermissionOutcome =
	| { outcome: 'cancelled' }
	| { outcome: 'selected'; optionId: string };

export interface AcpRequestPermissionResponse {
	outcome: AcpRequestPermissionOutcome;
	_meta?: Record<string, unknown>;
}

/** Envelope the Rust side emits on `acp://session/{threadId}/request`.
 *  Carries the `requestId` (so the reply can match it up) plus the full
 *  ACP-shaped request payload. */
export interface AcpRequestEnvelope {
	requestId: string;
	request: AcpRequestPermissionRequest;
}

/** Subscribe to `session/request_permission` requests for a thread. Used by
 *  the Phase 4 PermissionDialog and the acp-smoke harness. */
export async function acpListenRequests(
	threadId: string,
	onRequest: (envelope: AcpRequestEnvelope) => void
): Promise<UnlistenFn> {
	return listen<AcpRequestEnvelope>(`acp://session/${threadId}/request`, (e) =>
		onRequest(e.payload)
	);
}

/** Phase 4: reply to a `session/request_permission`. The Rust server
 *  resolves the parked oneshot, translates the outcome into a
 *  `sdk_control_response` envelope, and writes it back to claude's stdin. */
export async function acpRespondPermission(
	requestId: string,
	response: AcpRequestPermissionResponse
): Promise<void> {
	return invoke('acp_respond_permission', { requestId, response });
}

/** Phase 5: switch a session's permission mode. Pass one of the four
 *  canonical ACP ids advertised in `AcpNewSessionResponse.modes`. The
 *  Rust server updates the tracked mode for the session and, if a live
 *  streaming child exists, writes a `set_permission_mode` control_request
 *  to its stdin so the change applies mid-turn. Otherwise the next spawn
 *  picks it up via `--permission-mode`. */
export async function acpSetMode(threadId: string, modeId: AcpSessionModeId): Promise<void> {
	return invoke('acp_set_mode', { threadId, modeId });
}

/** ADR-011 phase 3: set the session's `--model`. Stored on Rust-side
 *  `SessionOpts.model`; applied on next spawn. Per-turn switching is
 *  deferred — if a streaming child is alive, the change takes effect on
 *  the next respawn. Pass `null` to clear the override and let claude
 *  use its own default. */
export async function acpSetModel(threadId: string, model: string | null): Promise<void> {
	return invoke('acp_set_model', { threadId, model });
}

/** ADR-011 phase 3: set the session's extended-thinking effort. Same
 *  semantics as `acpSetModel` — stored on `SessionOpts.effort` and
 *  applied on next spawn via `--thinking-budget-tokens`. `'off'` omits
 *  the flag entirely so claude's own default applies. */
export async function acpSetEffort(
	threadId: string,
	effort: 'off' | 'low' | 'medium' | 'high' | 'max'
): Promise<void> {
	return invoke('acp_set_effort', { threadId, effort });
}

// ─── ACP session fork + load (phase 8) ────────────────────────────────────────
//
// `session/fork` clones an existing session from a chosen turn. The new thread
// inherits the source's `claude_session_id` so the first prompt resumes
// against the source's on-disk JSONL transcript (`claude --resume <id>`).
// `session/load` re-attaches to an existing thread by id and returns its
// current mode advertisement so the frontend's mode picker can hydrate
// without paying cold-spawn cost. See `src-tauri/src/acp/server.rs`
// (`handle_fork_session` / `handle_load_session`) for the Phase 8 contract.

export interface AcpForkResult {
	newThreadId: string;
	sourceThreadId: string;
	branchedFromTurn?: number;
}

export interface AcpLoadSessionResponse {
	/** Initial mode state — same shape as `AcpNewSessionResponse.modes`,
	 *  exists when the server tracks per-session modes. */
	modes?: AcpSessionModes;
}

/** Phase 8: ACP `session/fork`. Clones `sourceThreadId` into a new thread
 *  that inherits the source's claude session id, so the first prompt resumes
 *  from the source's on-disk JSONL (`--resume <source_session_id>`).
 *
 *  `upToTurn` records the cutoff turn index for the relationship but does
 *  NOT (yet) truncate the JSONL byte-for-byte — Phase 8 is the minimum
 *  implementation; a future phase can do full transcript divergence. */
export async function acpForkSession(
	sourceThreadId: string,
	opts?: { upToTurn?: number; label?: string }
): Promise<AcpForkResult> {
	return invoke<AcpForkResult>('acp_fork_session', {
		sourceThreadId,
		upToTurn: opts?.upToTurn,
		label: opts?.label,
	});
}

/** Phase 8: ACP `session/load`. Re-attach to a session by `threadId` and
 *  return its current mode advertisement so the picker can hydrate. The
 *  claude child stays lazy — it spawns on the next `acpPrompt`. The
 *  on-disk transcript is read via the existing JSONL reader path. */
export async function acpLoadSession(threadId: string): Promise<AcpLoadSessionResponse> {
	return invoke<AcpLoadSessionResponse>('acp_load_session', { threadId });
}

// ─── ACP user-attention notify (phase 9) ──────────────────────────────────────
//
// Claude emits two event kinds that warrant pulling the user's attention:
//
//   - `Notification` hook (agent-initiated "need your input")
//   - `PermissionRequest` (tool approval round-trip — also surfaced via
//     `acp://session/{threadId}/request` for the in-UI dialog)
//
// The Rust side emits an `acp://notify` Tauri event for both. The frontend
// dispatcher (`src/lib/notifications/acp-notify-bridge.ts`) decides whether
// to fire an OS notification (via `tauri-plugin-notification`) AND/OR
// bump the sidebar badge counter. See the dispatcher for the focus-policy
// rules — Rust deliberately does NOT know about route/pane state.

export type AcpNotifyKind = 'notification' | 'permissionRequest';

export interface AcpNotifyPayload {
	threadId: string;
	title: string;
	body: string;
	kind: AcpNotifyKind;
}

/** Subscribe to `acp://notify` events from the Rust ACP server. Used by
 *  `acp-notify-bridge.ts` (the singleton dispatcher) and by the
 *  `ikengaAcpNotifyWatch` smoke helper. */
export async function acpListenNotify(
	callback: (payload: AcpNotifyPayload) => void
): Promise<UnlistenFn> {
	return listen<AcpNotifyPayload>('acp://notify', (e) => callback(e.payload));
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

// ─── Claude config — 4-tier layered discovery (Phase 4) ──────────────────────
//
// New surface for the Claude Config Browser UI. Returns *all* sources for each
// asset name (skill / agent / command / hook / mcp) across the four tiers so
// the UI can render conflicts and let the user pin a preferred provider.
//
// The legacy `claudeConfigLoad` helpers above stay around for the existing
// `/claude` route until that page migrates.

export type ClaudeAssetTier = 'personal' | 'workspace_pkg' | 'project' | 'project_pkg';

export type ClaudeAssetKind = 'skill' | 'agent' | 'command' | 'hook' | 'mcp';

export interface ClaudeAssetSource {
	tier: ClaudeAssetTier;
	/** pkg id, "personal", or "project:<id>". */
	provider: string;
	path: string;
	name: string;
	kind: ClaudeAssetKind;
}

export interface ClaudeAssetTree {
	skills: Record<string, ClaudeAssetSource[]>;
	agents: Record<string, ClaudeAssetSource[]>;
	commands: Record<string, ClaudeAssetSource[]>;
	hooks: Record<string, ClaudeAssetSource[]>;
	mcps: Record<string, ClaudeAssetSource[]>;
}

export interface ClaudeAssetPin {
	scope: string;
	asset_kind: ClaudeAssetKind;
	asset_name: string;
	preferred_tier: ClaudeAssetTier;
	preferred_source: string | null;
	updated_at: number;
}

/** Run the 4-tier discovery for `projectId` (defaults to the active project). */
export async function claudeAssetsDiscover(projectId?: string | null): Promise<ClaudeAssetTree> {
	return invoke<ClaudeAssetTree>('claude_assets_discover', {
		projectId: projectId ?? null,
	});
}

/** Pin an asset name to a tier (optionally a specific pkg-id provider). */
export async function claudeAssetPin(
	scope: string,
	assetKind: ClaudeAssetKind,
	assetName: string,
	preferredTier: ClaudeAssetTier,
	preferredSource?: string | null
): Promise<void> {
	return invoke('claude_asset_pin', {
		scope,
		assetKind,
		assetName,
		preferredTier,
		preferredSource: preferredSource ?? null,
	});
}

export async function claudeAssetUnpin(
	scope: string,
	assetKind: ClaudeAssetKind,
	assetName: string
): Promise<void> {
	return invoke('claude_asset_unpin', { scope, assetKind, assetName });
}

export async function claudeAssetListPins(scope: string): Promise<ClaudeAssetPin[]> {
	return invoke<ClaudeAssetPin[]>('claude_asset_list_pins', { scope });
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

/** DOM-tree probe result. `text` is the Playwright-style accessibility tree
 *  snapshot; `json` is the same data as a tree of `{ role, name, ref, value,
 *  children }` objects; `generation` bumps each snapshot so callers can
 *  detect stale refs. */
export interface IykeDomResult {
	text: string;
	json: unknown;
	generation: number;
}

/** Query the focused iframe's accessibility tree via the iyke bridge. Same
 *  mechanism as the `/iyke/dom` HTTP endpoint but exposed as a Tauri command
 *  so the Studio's right-rail DOM tab can refresh without round-tripping
 *  through localhost HTTP. `pane` is the leaf id; omit / "shell" for the
 *  main webview (Phase A only). */
export async function iykeDomQuery(args?: {
	query?: string;
	all?: boolean;
	pane?: string;
}): Promise<IykeDomResult> {
	return invoke('iyke_dom_query', {
		query: args?.query ?? null,
		all: args?.all ?? null,
		pane: args?.pane ?? null,
	});
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
	/** Phase 2 (projects-first-class): null/undefined = workspace scope
	 *  (always loaded); slug = project-scoped (loaded only when that
	 *  project is active). Optional so fixtures from before Phase 2
	 *  don't need a manual backfill. */
	project_id?: string | null;
}

export interface PkgKernelStatus {
	installed: PkgInstalledSummary[];
	registries: Record<string, unknown>;
	api_version: number;
}

export async function pkgInstallFromPath(
	installPath: string,
	scope?: PkgScopeWire | null
): Promise<{ installed: PkgInstalledSummary }> {
	return invoke('pkg_install_from_path', { installPath, scope: scope ?? null });
}

/** Phase 2 scope-picker wire format. `"workspace"` = always loaded;
 *  `"project:<id>"` = project-scoped; null/undefined = active project. */
export type PkgScopeWire = 'workspace' | `project:${string}`;

export async function pkgSetScope(pkgId: string, scope: PkgScopeWire | null): Promise<void> {
	return invoke('pkg_set_scope', { pkgId, scope });
}

/**
 * Install a pkg from a (registry-vetted) tarball URL. Rust downloads the
 * tarball, re-verifies SHA-512 against `integrity`, untars into the pkgs
 * dir, and hands off to the kernel as `InstallSource::Registry`.
 *
 * The TS registry-client is expected to have already signature-verified the
 * index that named this tarball — see `src/lib/registry/`.
 */
export interface PkgInstallFromRegistryArgs {
	tarball: string;
	integrity: string;
	pkgId: string;
	sourceUrl: string;
}

export async function pkgInstallFromRegistry(
	args: PkgInstallFromRegistryArgs,
	scope?: PkgScopeWire | null
): Promise<{ installed: PkgInstalledSummary }> {
	return invoke('pkg_install_from_registry', { args, scope: scope ?? null });
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

// ── Phase 9: pkg trust gating ─────────────────────────────────────────────

export interface PkgTrustPermsSummary {
	shell_execute: string[];
	fs_write_outside_sandbox: string[];
	net: string[];
	vault_keys: string[];
}

export type PkgTrustChangeReason =
	| { kind: 'never' }
	| { kind: 'permissions_changed'; prior_version: string; added: string[]; removed: string[] }
	| { kind: 'revoked' };

export type PkgTrustState = 'auto_trusted' | 'auto_granted' | 'granted' | 'needs_approval';

export interface PkgTrustEntry {
	pkg_id: string;
	version: string;
	state: PkgTrustState;
	perms: PkgTrustPermsSummary;
	last_granted_at_ms: number | null;
	change_reason: PkgTrustChangeReason | null;
	auto_trusted: boolean;
}

export interface PkgTrustPreview {
	pkg_id: string;
	version: string;
	perms: PkgTrustPermsSummary;
}

/**
 * List trust state for every installed pkg. Includes auto-trusted
 * builtins and skill-pack-only auto-grants alongside explicit grants and
 * pending approvals. Used by Settings → Pkgs Trust column.
 */
export async function pkgTrustList(): Promise<PkgTrustEntry[]> {
	return invoke<PkgTrustEntry[]>('pkg_trust_list');
}

/**
 * Per-pkg sensitive perms summary, fetched lazily when the Review dialog
 * opens. Returns the same shape as the `perms` field on a list entry.
 */
export async function pkgTrustPreview(pkgId: string): Promise<PkgTrustPreview> {
	return invoke<PkgTrustPreview>('pkg_trust_preview', { pkgId });
}

/**
 * Approve the pkg's *current* manifest sensitive-perms set. The version
 * string defends against a manifest update racing the dialog open; mismatch
 * rejects with an error so the FE can re-open with fresh data.
 */
export async function pkgTrustGrant(pkgId: string, version: string): Promise<void> {
	await invoke<void>('pkg_trust_grant', { pkgId, version });
}

/**
 * Revoke an existing trust grant. Subsequent MCP tools/call against this
 * pkg returns the structured `trust_required` error until re-granted.
 */
export async function pkgTrustRevoke(pkgId: string): Promise<void> {
	await invoke<void>('pkg_trust_revoke', { pkgId });
}

// ── Trust-review modal (2026-05-15) — capability-diff batch surface ──────
//
// Distinct from the Phase 9 sensitive-perms trust surface above. These
// commands gate boot-time capability changes (the FULL capabilities +
// permissions blocks) by parking the pkg out of the kernel's registry
// replay until the user approves or rejects the diff.

export interface PkgTrustReview {
	pkg_id: string;
	manifest_version: string;
	old_capabilities: string;
	new_capabilities: string;
	prior_approved_at_ms: number;
}

/**
 * List pkgs whose normalized capabilities + permissions differ from
 * their last-approved snapshot. Empty list = nothing to review.
 */
export async function pkgTrustListPending(): Promise<PkgTrustReview[]> {
	return invoke<PkgTrustReview[]>('pkg_trust_list_pending');
}

/**
 * Approve the current manifest's capabilities + permissions: write a new
 * explicit snapshot and re-register the pkg with the kernel (which boots
 * its sidecars / MCPs).
 */
export async function pkgTrustApprove(pkgId: string): Promise<void> {
	await invoke<void>('pkg_trust_approve', { pkgId });
}

/**
 * Reject the diff: delegate to the standard uninstall path.
 */
export async function pkgTrustReject(pkgId: string): Promise<void> {
	await invoke<void>('pkg_trust_reject', { pkgId });
}

// ─────────────────────────────────────────────────────────────────────────
// Runtime-ACL violations audit (2026-05-15)
// ─────────────────────────────────────────────────────────────────────────

export interface PkgPermissionViolation {
	id: number;
	pkg_id: string;
	scope_kind: string;
	attempted: string;
	declared: string;
	occurred_at: number;
}

/**
 * List permission-violation audit rows newest-first. `pkgId` filters to one
 * pkg; omit for cross-pkg counts (the Settings overview badge). `limit`
 * defaults to 100 and is hard-capped at 1000 server-side.
 */
export async function pkgPermissionViolationsList(
	pkgId?: string,
	limit?: number
): Promise<PkgPermissionViolation[]> {
	return invoke<PkgPermissionViolation[]>('pkg_permission_violations_list', {
		pkgId: pkgId ?? null,
		limit: limit ?? null,
	});
}

/**
 * Delete the named pkg's audit rows. Audit-only — does not alter trust
 * state or re-grant anything. Returns the number of rows removed.
 */
export async function pkgPermissionViolationsClear(pkgId: string): Promise<number> {
	return invoke<number>('pkg_permission_violations_clear', { pkgId });
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

// ─── Pkg child-webview panes (Phase 1) ──────────────────────────────────
//
// Native webview surfaces owned by the kernel and rendered as a child of
// the main Tauri window. The React side mounts a placeholder div
// (`PkgWebviewHost`) that measures its DOM rect and asks the kernel to
// create / move / destroy a webview at that rect. The webview floats over
// the React tree natively; navigation, eval, and cookie isolation are
// driven by the kernel + the pkg's MCP server, not by React.
//
// Backed by `src-tauri/src/commands/pkg_webview.rs` and the
// `WebviewPanesRegistry` (`src-tauri/src/pkg/webview.rs`). The `eval` and
// `set_visible` paths exist in Rust but are intentionally NOT exposed to
// the FE — only the kernel and pkg-MCP servers ever drive them.

export interface PkgWebviewRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PkgWebviewCreateResult {
	/** Internal label assigned by the kernel (e.g. `pkg-com-ikenga-browser-spotify`). Opaque. */
	webviewLabel: string;
}

/** Create a child webview for `(pkgId, paneId)` at `rect`, loading `url`.
 *  `partition` selects a per-pkg cookie jar (must be one of the partitions
 *  declared in the pkg's `capabilities.webview.partitions`); omit / null
 *  for the default jar. The returned label is opaque — the React side
 *  doesn't need it (subsequent ops are keyed on `(pkgId, paneId)`), but
 *  it's surfaced for logging / debugging. */
export async function pkgWebviewCreate(
	pkgId: string,
	paneId: string,
	url: string,
	rect: PkgWebviewRect,
	partition?: string | null
): Promise<PkgWebviewCreateResult> {
	// Rust-side `PkgWebviewCreateResult` carries `#[serde(rename_all = "camelCase")]`
	// so the wire format is `webviewLabel` already — no normalization needed.
	return invoke<PkgWebviewCreateResult>('pkg_webview_create', {
		pkgId,
		paneId,
		url,
		rect,
		partition: partition ?? null,
	});
}

export async function pkgWebviewDestroy(pkgId: string, paneId: string): Promise<void> {
	return invoke('pkg_webview_destroy', { pkgId, paneId });
}

export async function pkgWebviewSetRect(
	pkgId: string,
	paneId: string,
	rect: PkgWebviewRect
): Promise<void> {
	return invoke('pkg_webview_set_rect', { pkgId, paneId, rect });
}

export async function pkgWebviewNavigate(
	pkgId: string,
	paneId: string,
	url: string
): Promise<void> {
	return invoke('pkg_webview_navigate', { pkgId, paneId, url });
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
	/** Stable artifact id from the manifest. Lookup key for
	 *  `ikenga://artifact/<id>`. NULL on non-artifact pins and on artifact
	 *  pins authored without an `id` field. */
	manifestId: string | null;
	/** ISO-8601 UTC timestamp of the most recent open. NULL until the pin is
	 *  first opened via the resolver. */
	lastOpenedAt: string | null;
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
	/** Stable artifact id (from `<script id="ikenga-manifest">`). Required
	 *  for `ikenga://artifact/<id>` to resolve back to this pin; optional
	 *  otherwise. */
	manifestId?: string | null;
}): Promise<ActivityPin> {
	return invoke<ActivityPin>('activity_pins_add', {
		kind: args.kind,
		target: args.target,
		label: args.label,
		iconLucide: args.iconLucide ?? null,
		iconEmoji: args.iconEmoji ?? null,
		sectionId: args.sectionId ?? null,
		manifestId: args.manifestId ?? null,
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

/** Look up a pinned artifact by its manifest id. Returns null when no pin
 *  claims this id. Read-only — use `activityPinsTouchOpen` to bump recency
 *  after the artifact actually mounts. */
export async function activityPinsResolveArtifact(manifestId: string): Promise<ActivityPin | null> {
	return invoke<ActivityPin | null>('activity_pins_resolve_artifact', { manifestId });
}

/** Stamp `lastOpenedAt` to "now" for a pin. Fire-and-forget after a
 *  successful artifact open. */
export async function activityPinsTouchOpen(pinId: string): Promise<void> {
	return invoke('activity_pins_touch_open', { pinId });
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

export async function detectAgent(agentId: string): Promise<DetectedAgent | null> {
	return invoke<DetectedAgent | null>('detect_agent', { agentId });
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

// ─── Projects (Phase 0 — first-class) ────────────────────────────────────────
//
// Projects are top-level scoping containers for sessions, pkgs, layout state,
// memory, etc. Migration 0015 introduces the `projects` + `project_settings`
// tables; a Default project ships in the seed and cannot be archived. The
// active project id is mirrored in `settings_kv` under `shell.activeProjectId`
// (Rust-owned). Switches emit a Tauri event `projects:active-changed` so
// project-scoped queries can invalidate.
//
// Wire format mirrors `src-tauri/src/commands/projects.rs` exactly: snake_case
// over the JSON wire because the Rust struct is serde-default. Keep these
// types snake_case in TS too — there is no boundary translation.

export interface Project {
	id: string;
	display_name: string;
	root_path: string | null;
	icon: string | null;
	color: string | null;
	description: string | null;
	position: number;
	is_default: boolean;
	created_at: number;
	archived_at: number | null;
}

export interface ProjectCreateArgs {
	id: string;
	display_name: string;
	root_path?: string | null;
	icon?: string | null;
	color?: string | null;
	description?: string | null;
}

export interface ProjectPatch {
	display_name?: string | null;
	root_path?: string | null;
	icon?: string | null;
	color?: string | null;
	description?: string | null;
	position?: number | null;
}

export async function projectCreate(args: ProjectCreateArgs): Promise<Project> {
	return invoke<Project>('project_create', {
		id: args.id,
		displayName: args.display_name,
		rootPath: args.root_path ?? null,
		icon: args.icon ?? null,
		color: args.color ?? null,
		description: args.description ?? null,
	});
}

export async function projectUpdate(id: string, patch: ProjectPatch): Promise<Project> {
	return invoke<Project>('project_update', { id, patch });
}

export async function projectList(includeArchived = false): Promise<Project[]> {
	return invoke<Project[]>('project_list', { includeArchived });
}

export async function projectArchive(id: string): Promise<void> {
	return invoke('project_archive', { id });
}

export async function projectSetActive(id: string): Promise<void> {
	return invoke('project_set_active', { id });
}

export async function projectGetActive(): Promise<Project> {
	return invoke<Project>('project_get_active');
}

/** Subscribe to project-switch events. The Rust side emits `projects:active-changed`
 *  with `{ id }` payload whenever `project_set_active` succeeds. Consumers
 *  typically just call `queryClient.invalidateQueries({ queryKey: ['project-scoped'] })`.
 *
 *  Tauri 2.11+ enforces event-name validation: dots aren't allowed in names
 *  (`IllegalEventName`), so the canonical separator here is `:`. */
export async function projectListenActiveChanged(
	callback: (payload: { id: string }) => void
): Promise<UnlistenFn> {
	return listen<{ id: string }>('projects:active-changed', (e) => callback(e.payload));
}

// ─── Phase 0.5 background-execution spike (debug-only) ────────────────────────
//
// Pairs with src-tauri/src/commands/bg_spike.rs. The Rust side is gated on
// cfg(debug_assertions); the FE side is gated on import.meta.env.DEV by
// the install helper in src/main.tsx (window.__bgSpikeInstall). Delete both
// once Phase 0.5 is signed off — these aren't a permanent surface.

export interface BgSpikeReport {
	intendedCount: number;
	completedCount: number;
	timeoutCount: number;
	durationMs: number;
	p50Us: number;
	p95Us: number;
	p99Us: number;
	maxUs: number;
	sampleUs: number[];
	webviewLabel: string;
}

export async function bgSpikeRun(
	durationMs: number,
	intervalMs: number,
	perPingTimeoutMs: number
): Promise<BgSpikeReport> {
	return invoke<BgSpikeReport>('bg_spike_run', {
		durationMs,
		intervalMs,
		perPingTimeoutMs,
	});
}

// ─── Artifact comments (artifact-grid pin overlay) ───────────────────────
//
// See plans/shell/2026-05-16-artifact-grid-brainstorm.md. Schema in migration
// 0022. Routing (terminal claude vs side-pane Chat) is handled by a separate
// dispatcher (Phase 4); these are pure persistence + lifecycle calls.

export type CommentStatus = 'open' | 'in_progress' | 'resolved' | 'stale';
export type CommentSink = 'terminal' | 'sidepane' | 'both';

export interface Comment {
	id: number;
	artifactPath: string;
	selector: string;
	text: string;
	screenshotPath: string | null;
	status: CommentStatus;
	positionX: number | null;
	positionY: number | null;
	threadId: string | null;
	openingSessionId: string | null;
	sink: CommentSink | null;
	createdAt: number;
	acknowledgedAt: number | null;
	resolvedAt: number | null;
}

export async function commentCreate(args: {
	artifactPath: string;
	selector: string;
	text: string;
	screenshotPath?: string | null;
	positionX?: number | null;
	positionY?: number | null;
}): Promise<Comment> {
	return invoke<Comment>('comment_create', {
		artifactPath: args.artifactPath,
		selector: args.selector,
		text: args.text,
		screenshotPath: args.screenshotPath ?? null,
		positionX: args.positionX ?? null,
		positionY: args.positionY ?? null,
	});
}

export async function commentGet(id: number): Promise<Comment> {
	return invoke<Comment>('comment_get', { id });
}

/** List pin comments. Pass `artifactPath` to scope to one artifact (cell
 *  render path), or omit for the cross-folder inbox view. Resolved pins are
 *  hidden by default. */
export async function commentList(args?: {
	artifactPath?: string | null;
	includeResolved?: boolean;
}): Promise<Comment[]> {
	return invoke<Comment[]>('comment_list', {
		artifactPath: args?.artifactPath ?? null,
		includeResolved: args?.includeResolved ?? false,
	});
}

/** Record which sink the dispatcher chose for this pin. Stamps `sink` plus
 *  `threadId` / `openingSessionId` audit fields. Idempotent — re-routing
 *  the same pin overwrites `sink` but COALESCEs the session ids so the
 *  earliest values stay. */
export async function commentRecordRouting(args: {
	id: number;
	sink: CommentSink;
	threadId?: string | null;
	openingSessionId?: string | null;
}): Promise<Comment> {
	return invoke<Comment>('comment_record_routing', {
		id: args.id,
		sink: args.sink,
		threadId: args.threadId ?? null,
		openingSessionId: args.openingSessionId ?? null,
	});
}

/** Set the pin's status. Agent transitions: open→in_progress (via
 *  `pin_acknowledge`) and any→resolved (via `pin_resolve`). User can also
 *  resolve manually from the grid UI. Timestamp fields are stamped on the
 *  first transition into each state and never overwritten. */
export async function commentSetStatus(id: number, status: CommentStatus): Promise<Comment> {
	return invoke<Comment>('comment_set_status', { id, status });
}

export async function commentDelete(id: number): Promise<void> {
	return invoke('comment_delete', { id });
}

/** Persist a base64-encoded PNG (from `captureToPng` on the FE) to disk
 *  under `$app_data_dir/pin-screenshots/<uuid>.png` and return the absolute
 *  path. Used by the pin composer to materialise an element screenshot
 *  before stamping the path on `commentCreate`. */
export async function pinScreenshotWrite(base64Png: string): Promise<string> {
	return invoke<string>('pin_screenshot_write', { base64Png });
}

/** Routing sink. `terminal` writes the structured prompt to the active claude
 *  PTY's stdin (claude pulls the full payload via `mcp-iyke.read_pin`).
 *  `sidepane` fires a `pin://routed` Tauri event the FE listens to and posts
 *  into the active side-pane Chat thread. `both` runs both branches. */
export type RouteSink = 'terminal' | 'sidepane' | 'both';

export interface RouteResult {
	/** Sink actually used. `null` when nothing was reachable. */
	sink: RouteSink | null;
	/** PTY id used when the terminal branch fired. */
	ptyId: string | null;
	/** Foreground command on that PTY at routing time (e.g. `"claude"`). */
	ptyForeground: string | null;
	comment: Comment;
}

/** Dispatch a pin to its routing sink. Auto-detects when `overrideSink` is
 *  omitted: most-recently-active claude PTY wins; falls back to side-pane
 *  Chat. ⌥-click on the pin in the grid passes an explicit override. */
export async function commentRoute(args: {
	id: number;
	overrideSink?: RouteSink;
}): Promise<RouteResult> {
	const raw = await invoke<{
		sink: string | null;
		pty_id: string | null;
		pty_foreground: string | null;
		comment: Comment;
	}>('comment_route', {
		id: args.id,
		overrideSink: args.overrideSink ?? null,
	});
	return {
		sink: (raw.sink as RouteSink | null) ?? null,
		ptyId: raw.pty_id,
		ptyForeground: raw.pty_foreground,
		comment: raw.comment,
	};
}

/** Payload emitted on `pin://routed` when the sidepane branch fires. The
 *  FE listens for this and posts the structured prompt into the active
 *  side-pane Chat thread. */
export interface PinRoutedEvent {
	id: number;
	sink: 'sidepane';
	artifact_path: string;
	selector: string;
	text: string;
	screenshot_path: string | null;
}

export async function listenPinRouted(handler: (e: PinRoutedEvent) => void): Promise<UnlistenFn> {
	return listen<PinRoutedEvent>('pin://routed', (e) => handler(e.payload));
}

// ─── Artifact-studio chat threads (unified Studio, D3) ────────────────────
//
// See plans/shell/2026-05-16-artifact-studio-unified.md §"Chat thread model".
// One thread per folder; the scope chip (folder · artifact · element · compare)
// travels with each message rather than forking the thread. Schema in
// migration 0023.

export type StudioRole = 'user' | 'claude' | 'tool';

export type StudioScopeKind = 'folder' | 'artifact' | 'element' | 'compare';

/** Shape stored in `scopeChipJson`. The backend doesn't introspect this — the
 *  renderer parses and falls back gracefully on unknown kinds. New scope
 *  kinds can ship without a migration. */
export type StudioScopeChip =
	| { kind: 'folder'; target: string }
	| { kind: 'artifact'; target: string }
	| {
			kind: 'element';
			target: string;
			selector: string;
			pinId?: number | null;
	  }
	| {
			kind: 'compare';
			target: string;
			left: string;
			right: string;
	  };

export interface StudioThread {
	id: string;
	folderPath: string;
	createdAt: number;
	lastMessageAt: number;
}

export interface StudioMessage {
	id: number;
	threadId: string;
	role: StudioRole;
	contentMd: string;
	/** Raw JSON string (server-side opaque). Use `parseStudioScopeChip` to read. */
	scopeChipJson: string | null;
	createdAt: number;
}

/** Idempotent: returns the existing thread for this folder, or creates a new
 *  one. Call on Studio pane mount. */
export async function studioThreadGetOrCreate(folderPath: string): Promise<StudioThread> {
	return invoke<StudioThread>('studio_thread_get_or_create', { folderPath });
}

export async function studioThreadGet(id: string): Promise<StudioThread> {
	return invoke<StudioThread>('studio_thread_get', { id });
}

/** Recently-active threads, sorted by `lastMessageAt` desc. Default limit 50,
 *  clamped server-side to [1, 500]. */
export async function studioThreadListRecent(limit?: number): Promise<StudioThread[]> {
	return invoke<StudioThread[]>('studio_thread_list_recent', {
		limit: limit ?? null,
	});
}

/** Hard delete a thread and all its messages (cascade). No undo. Confirm
 *  before calling. */
export async function studioThreadDelete(id: string): Promise<void> {
	return invoke('studio_thread_delete', { id });
}

export async function studioMessageAppend(args: {
	threadId: string;
	role: StudioRole;
	contentMd: string;
	scopeChip?: StudioScopeChip | null;
}): Promise<StudioMessage> {
	return invoke<StudioMessage>('studio_message_append', {
		threadId: args.threadId,
		role: args.role,
		contentMd: args.contentMd,
		scopeChipJson: args.scopeChip ? JSON.stringify(args.scopeChip) : null,
	});
}

/** List messages in a thread, oldest first. `beforeCreatedAt` pages backwards
 *  for scroll-up history. Default limit 500, clamped to [1, 2000]. */
export async function studioMessageList(args: {
	threadId: string;
	limit?: number;
	beforeCreatedAt?: number;
}): Promise<StudioMessage[]> {
	return invoke<StudioMessage[]>('studio_message_list', {
		threadId: args.threadId,
		limit: args.limit ?? null,
		beforeCreatedAt: args.beforeCreatedAt ?? null,
	});
}

/** Best-effort parse of `scopeChipJson`. Returns null on missing/invalid JSON
 *  or unknown `kind`. Caller decides how to render the fallback. */
export function parseStudioScopeChip(json: string | null): StudioScopeChip | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as { kind?: string };
		switch (parsed.kind) {
			case 'folder':
			case 'artifact':
			case 'element':
			case 'compare':
				return parsed as StudioScopeChip;
			default:
				return null;
		}
	} catch {
		return null;
	}
}

// startArtifact — wires up the agent + Studio loupe handoff.
//
// Two agent flavors share most of the flow:
//
//   - **Terminal** (claude / codex / gemini / custom): spawn a PTY, type
//     the kickoff via bracketed paste, mount as a `terminal` pane.
//   - **Chat**: mint an ACP chat thread, mount as a `chat` pane, push the
//     kickoff through the adapter's send pipeline.
//
// Either way the Studio opens in grid density on the chosen folder
// alongside the agent pane. A file-watcher then swaps grid → loupe when
// the agent's first `.html` lands. Terminal flow runs the handoff-prompt
// after the swap; chat skips it (no terminal to attach).
//
// The watcher outlives the wizard component — fire-and-forget side effect
// with a 30-minute self-timeout so it doesn't leak if the agent never
// writes anything.
//
// The chat half of that flow is also exported on its own as
// `startSeededChat()` — the shared seam for non-wizard callers that need to
// open a chat pane pre-loaded with a kickoff prompt. The shell's New-Session
// dialog (WP-27 / G-SESSION-DIALOG, supersedes the retired
// `host.startChatSession` verb / WP-10) drives this through its own Start
// handler; keep this the single mint → mount → send path so behavior stays
// consistent across the wizard, the dialog, and any future seeded-session
// entrypoint.
//
// Phase-4 (WP-22) adds a *sibling* path in
// `src/components/pkg/send-to-active-session.ts` that targets the focused
// chat pane's existing thread instead of minting. That sibling reuses this
// file's `appendUserTurn → adapter.send → drain` pipeline but skips the
// mint + mount + pane-split steps. The frozen verb is
// `host.sendToActiveSession({ prompt, source? })` (G-ACTIVE-SESSION).

import { mintThreadId, defaultChatAdapterId } from '@/chat';
import { appendUserTurn, createThread } from '@/chat/persist';
import { getAdapter } from '@/chat/registry';
import { useChatStore } from '@/chat/store';
import {
	fsListenWatch,
	fsMkdir,
	fsUnwatch,
	fsWatch,
	ptyWrite,
	sessionEnsure,
	type Project,
} from '@/lib/tauri-cmd';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { usePaneStore } from '@/lib/panes/pane-store';
import { defaultCwd } from '@/lib/shell/default-cwd';
import { useShellStore } from '@/lib/shell/shell-store';
import { createTerminalSession } from '@/terminal/single-terminal';
import { useTerminalStore } from '@/terminal/session-store';
import { type Archetype, slugifyName } from '@/shell/artifact-wizard/archetypes';
import { requestOrApplyHandoff } from '@/shell/artifact-wizard/handoff-pref';
import { useWizardPopStore } from '@/shell/artifact-wizard/pop-recovery-store';

export type AgentChoice =
	| { kind: 'chat' }
	| { kind: 'claude' }
	| { kind: 'codex' }
	| { kind: 'gemini' }
	| { kind: 'custom'; cmd: string[] };

export interface StartArgs {
	project: Project;
	archetype: Archetype;
	/** Display name. Surfaced to the agent + slugified for the path hint. */
	name: string;
	/** Absolute folder path the agent is expected to write the artifact into.
	 *  Surfaced in the kickoff prompt + used as the prefix filter on the
	 *  project-root file watcher. The folder doesn't need to exist yet — the
	 *  agent may create it. */
	folder: string;
	/** Which CLI to spawn. claude / codex / gemini are well-known; `custom`
	 *  passes a user-supplied argv through. */
	agent: AgentChoice;
}

function resolveAgentCmd(agent: Exclude<AgentChoice, { kind: 'chat' }>): {
	cmd: string[];
	title: string;
} {
	switch (agent.kind) {
		case 'claude':
			return { cmd: ['claude'], title: 'claude' };
		case 'codex':
			return { cmd: ['codex'], title: 'codex' };
		case 'gemini':
			return { cmd: ['gemini'], title: 'gemini' };
		case 'custom':
			return { cmd: agent.cmd, title: agent.cmd[0] ?? 'agent' };
	}
}

export interface StartResult {
	/** Set when the agent surface is a terminal pane. */
	terminalSessionId: string | null;
	/** Set when the agent surface is a chat pane. */
	threadId: string | null;
	slug: string;
	kickoffPrompt: string;
}

const WATCHER_TIMEOUT_MS = 30 * 60 * 1000;
const PTY_READY_TIMEOUT_MS = 10_000;
/** Delay between PTY-ready and prompt write. Gives the agent time to
 *  render its splash and reach an input-ready state before we type.
 *  claude / codex / gemini all show launch chrome and are equally
 *  forgiving of this default. */
const PROMPT_TYPING_DELAY_MS = 1500;
/** Delay between bracketed paste end and the submit Enter. Without this
 *  the TUI batches the Enter into the paste payload and treats it as
 *  another newline instead of a submit. */
const POST_PASTE_DELAY_MS = 200;
/** How long the watcher will hold off firing on a non-slug-matching `.html`
 *  while it waits for the agent's actual file. If the agent writes the
 *  expected file inside this window, the watcher pops the loupe on that
 *  instead. Tuned to be long enough to absorb a stray sibling create,
 *  short enough that the user isn't left staring at a blank grid. */
const FALLBACK_GRACE_MS = 5_000;

export async function startArtifact(args: StartArgs): Promise<StartResult> {
	const slug = slugifyName(args.name);
	const kickoffPrompt = args.archetype.kickoffPrompt({
		project: {
			display_name: args.project.display_name,
			root_path: args.project.root_path,
		},
		slug,
	});

	// Make sure the watched folder exists before the watcher arms — otherwise
	// a `<project>/<archetype-subdir>/` that doesn't exist yet would silently
	// miss the first create event because notify watches a non-existent path
	// as the parent dir, and our prefix filter wouldn't match the created
	// subdir entry. Idempotent. Errors are logged + soft-fail; the watcher
	// still runs against the project root.
	if (args.folder.length > 0) {
		await fsMkdir(args.folder).catch((e) => {
			console.warn('[wizard] mkdir', args.folder, 'failed (continuing):', e);
		});
	}

	// Layout (shared across both agent flavors): Studio on the left (active
	// pane) in grid density pointed at the chosen folder, agent surface
	// (terminal or chat) split off to the right. We re-focus the Studio so
	// the user can drive it without a click. When the watcher fires, the
	// Studio's view swaps grid → loupe in place; the agent pane stays
	// untouched on the right.
	const cwd = args.project.root_path ?? args.folder;
	const paneStore = usePaneStore.getState();
	const studioLeafId = paneStore.focusedId;
	paneStore.addTab(studioLeafId, {
		kind: 'artifact-studio',
		path: args.folder,
		density: 'grid',
	});

	let terminalSessionId: string | null = null;
	let threadId: string | null = null;
	let agentLeafId: string;

	if (args.agent.kind === 'chat') {
		// The chat surface delegates its full mint → mount → send pipeline to
		// the shared `startSeededChat` seam. With `split: 'right'` it splits
		// the focused (Studio) leaf horizontally and mounts the chat pane on
		// the new right leaf, returning that pane's id.
		const seeded = await startSeededChat({
			prompt: kickoffPrompt,
			projectId: args.project.id,
			title: `${args.archetype.label}: ${args.project.display_name}`,
			split: 'right',
		});
		threadId = seeded.threadId;
		agentLeafId = seeded.paneId;
	} else {
		paneStore.splitPane(studioLeafId, 'horizontal');
		agentLeafId = usePaneStore.getState().focusedId;
		terminalSessionId = mountTerminalAgent({
			agent: args.agent,
			cwd,
			archetypeLabel: args.archetype.label,
			agentLeafId,
		});
		// Type the kickoff prompt into the PTY once it's ready. Fire and
		// forget — the chat path's autoSend covers the equivalent step.
		void typeKickoff(terminalSessionId, kickoffPrompt);
	}

	usePaneStore.getState().focusPane(studioLeafId);

	// Watch the project root recursively and swap the Studio leaf's view
	// from grid → loupe when the agent's file lands under the chosen
	// folder. After the swap, terminal flows run the handoff prompt;
	// chat flows skip it (no terminal to attach).
	if (args.project.root_path) {
		void watchForArtifact({
			rootPath: args.project.root_path,
			folderPrefix: args.folder,
			studioLeafId,
			agentLeafId,
			terminalSessionId,
			slug,
		});
	}

	return { terminalSessionId, threadId, slug, kickoffPrompt };
}

// ─── Agent mounts ────────────────────────────────────────────────────────

function mountTerminalAgent(args: {
	agent: Exclude<AgentChoice, { kind: 'chat' }>;
	cwd: string;
	archetypeLabel: string;
	agentLeafId: string;
}): string {
	const { cmd, title: agentTitle } = resolveAgentCmd(args.agent);
	const sessionId = createTerminalSession({
		cwd: args.cwd,
		cmd,
		title: `${agentTitle} · ${args.archetypeLabel.toLowerCase()}`,
	});
	usePaneStore.getState().addTab(args.agentLeafId, {
		kind: 'terminal',
		sessionId,
	});
	return sessionId;
}

export interface StartSeededChatOptions {
	/** Kickoff prompt; rendered as the thread's first user turn and sent. */
	prompt: string;
	/** Project to scope the thread to. Defaults to the active project
	 *  (`shell-store.activeProjectId`). The session cwd is resolved from this
	 *  project's `root_path`, falling back to `defaultCwd()` when the project
	 *  has none (e.g. the seed Default project). */
	projectId?: string;
	/** Chat pane title. Defaults to `'Untitled session'`. */
	title?: string;
	/** Engine/adapter to mount the thread on (`claude-code`, `gemini`, …).
	 *  Defaults to `defaultChatAdapterId()`. Persisted as the thread's
	 *  `engine_id` per ADR-013 §2. */
	engineId?: string;
	/** Where to mount the chat pane. `'right'`/`'bottom'` split the focused
	 *  leaf (horizontal/vertical) and mount on the new leaf; `null` (default)
	 *  mounts on the currently-focused leaf without splitting. */
	split?: 'right' | 'bottom' | null;
}

export interface StartSeededChatResult {
	threadId: string;
	paneId: string;
}

/**
 * Mint a fresh chat thread, mount a chat pane, and send the kickoff prompt.
 *
 * The artifact-creation wizard's proven mint → ensure → persist → mount → send
 * pipeline, lifted out of its `onConfirm` chain so non-wizard callers (the
 * shell's New-Session dialog Start handler) can reuse it without
 * re-implementing the dance. Returns the thread + pane ids so callers can
 * publish them as state, focus the pane, etc.
 *
 * Ordering is load-bearing: the thread is minted and persisted before the pane
 * mounts (so the pane hydrates from the in-memory store rather than racing the
 * DB → store loop), and the kickoff send is fire-and-forget after mount.
 */
export async function startSeededChat(
	opts: StartSeededChatOptions
): Promise<StartSeededChatResult> {
	const { prompt, title = 'Untitled session', split = null } = opts;

	const shell = useShellStore.getState();
	const projectId = opts.projectId ?? shell.activeProjectId;
	const project = shell.projects.find((p) => p.id === projectId);
	const cwd = project?.root_path ?? defaultCwd();
	const adapterId = opts.engineId ?? defaultChatAdapterId();

	const threadId = mintThreadId();
	const now = Date.now();

	// Rust-side session row up front so the streaming child can spawn on
	// the first prompt (idempotent — adapter.attach also calls this).
	await sessionEnsure(threadId, cwd, {});

	// Persist the thread so it survives a reload.
	await createThread({
		id: threadId,
		adapterId,
		cwd,
		claudeSessionId: null,
		model: null,
		title,
		projectId,
	});

	// Mirror into the in-memory store so the chat pane mounts with the
	// thread already known. Without this the pane has to wait for the
	// DB → store hydration loop, which races with autoSend below.
	useChatStore.getState().upsertThread({
		id: threadId,
		adapterId,
		// ADR-013 §2: `engineId` is the persisted engine for the thread.
		// New threads default to the adapter that minted them, matching
		// what `createThread()` writes to `chat_sessions.engine_id`.
		engineId: adapterId,
		title,
		cwd,
		model: null,
		claudeSessionId: null,
		ptyId: null,
		projectId,
		createdAt: now,
		updatedAt: now,
	});

	// Resolve the mount target, splitting the focused leaf first if asked.
	const paneStore = usePaneStore.getState();
	let paneId = paneStore.focusedId;
	if (split) {
		paneStore.splitPane(paneId, split === 'right' ? 'horizontal' : 'vertical');
		paneId = usePaneStore.getState().focusedId;
	}

	// Mount the chat pane and auto-send the kickoff prompt.
	usePaneStore.getState().addTab(paneId, {
		kind: 'chat',
		sessionId: threadId,
	});
	void autoSendKickoff(threadId, adapterId, prompt);

	return { threadId, paneId };
}

async function autoSendKickoff(threadId: string, adapterId: string, text: string): Promise<void> {
	try {
		const turn = await appendUserTurn(threadId, text);
		useChatStore.getState().appendEvents(threadId, [
			{
				kind: 'user_turn',
				text: turn.text,
				sequence: turn.sequence,
				createdAt: turn.createdAt,
			},
		]);
		const adapter = getAdapter(adapterId);
		useChatStore.getState().setStatus(threadId, 'streaming');
		const { iterable } = adapter.send({ threadId, text });
		try {
			for await (const _ev of iterable) {
				// drain — the adapter's own listeners persist + push events
			}
		} finally {
			if (useChatStore.getState().threads[threadId]?.status === 'streaming') {
				useChatStore.getState().setStatus(threadId, 'idle');
			}
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error('[wizard] chat autoSend failed:', e);
		useChatStore.getState().setStatus(threadId, 'error', msg);
	}
}

/** Wait for the PTY id to land in the session-store, give the agent a beat
 *  to finish its splash, then bracket-paste the prompt and submit with a
 *  separate Enter keystroke.
 *
 *  Bracketed paste (`\x1b[200~ … \x1b[201~`) signals to the TUI input that
 *  the multi-line payload is a single pasted block — without it, embedded
 *  `\n`s fire intermediate newlines and the trailing CR is absorbed as
 *  another newline instead of a submit. The follow-up `\r` after a short
 *  delay then submits cleanly. Works across claude / codex / gemini. */
async function typeKickoff(sessionId: string, prompt: string): Promise<void> {
	const ptyId = await awaitPtyId(sessionId, PTY_READY_TIMEOUT_MS);
	if (!ptyId) {
		console.warn('[wizard] PTY never reported a ptyId — prompt not typed');
		return;
	}
	await wait(PROMPT_TYPING_DELAY_MS);
	try {
		await ptyWrite(ptyId, `\x1b[200~${prompt}\x1b[201~`);
		await wait(POST_PASTE_DELAY_MS);
		await ptyWrite(ptyId, '\r');
	} catch (e) {
		console.error('[wizard] ptyWrite failed:', e);
	}
}

function awaitPtyId(sessionId: string, timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		const initial = useTerminalStore.getState().tabs.find((t) => t.id === sessionId)?.ptyId ?? null;
		if (initial) {
			resolve(initial);
			return;
		}
		const timer = setTimeout(() => {
			unsub();
			resolve(null);
		}, timeoutMs);
		const unsub = useTerminalStore.subscribe((state) => {
			const tab = state.tabs.find((t) => t.id === sessionId);
			if (tab?.ptyId) {
				clearTimeout(timer);
				unsub();
				resolve(tab.ptyId);
			}
		});
	});
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Watch the project root recursively for the agent's file. Prefers any
 *  `.html` whose basename contains `slug` (case-insensitive); falls back
 *  to the first non-matching `.html` under `folderPrefix` after a short
 *  grace period so a stray sibling create doesn't pop the wrong file.
 *
 *  Swap sequence on fire: grid → loupe in place, then route the terminal
 *  pane through the handoff prompt / persisted pref. Self-terminates
 *  after 30 minutes if nothing lands. */
async function watchForArtifact(args: {
	rootPath: string;
	folderPrefix: string;
	studioLeafId: string;
	/** The leaf the agent surface (terminal OR chat) was mounted on. */
	agentLeafId: string;
	/** Set when the agent is a terminal — used to feed the handoff prompt.
	 *  Null for chat agents (no terminal to attach). */
	terminalSessionId: string | null;
	slug: string;
}): Promise<void> {
	const { rootPath, folderPrefix, studioLeafId, agentLeafId, terminalSessionId, slug } = args;
	const normalizedPrefix = folderPrefix.replace(/\/+$/, '');
	const slugLower = slug.toLowerCase();
	let watcherId: string | null = null;
	let unlisten: (() => void) | null = null;
	let cleaned = false;
	/** First non-slug-matching `.html` we've seen, held in case the slug
	 *  match never lands. Falls through after FALLBACK_GRACE_MS. */
	let fallback: { path: string } | null = null;
	let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

	function cleanup(): void {
		if (cleaned) return;
		cleaned = true;
		if (unlisten) {
			try {
				unlisten();
			} catch {}
			unlisten = null;
		}
		if (watcherId) {
			void fsUnwatch(watcherId).catch(() => {});
			watcherId = null;
		}
		if (fallbackTimer) {
			clearTimeout(fallbackTimer);
			fallbackTimer = null;
		}
	}

	const timeout = setTimeout(cleanup, WATCHER_TIMEOUT_MS);

	function fire(path: string, reason: 'slug-match' | 'fallback'): void {
		console.info('[wizard] artifact detected', path, `(${reason}) → swapping grid → loupe`);
		swapStudioToLoupe(studioLeafId, path);
		// Fallback fires might be the wrong file (a stray sibling create
		// landed before the agent's actual file). Post a recovery record so
		// the workspace-mounted chip offers the user one-click backtrack to
		// the folder grid. Slug-match fires skip this — they're almost
		// always the right file.
		if (reason === 'fallback') {
			useWizardPopStore.getState().post({
				paneId: studioLeafId,
				artifactPath: path,
				folder: normalizedPrefix,
				postedAt: Date.now(),
			});
		}
		// Terminal flows: prompt the user (or apply their persisted pref)
		// for the right-pane terminal handoff. Chat flows skip — there's
		// no PTY owner to flip and the chat pane stays beside the loupe.
		if (terminalSessionId) {
			void requestOrApplyHandoff({
				terminalSessionId,
				terminalLeafId: agentLeafId,
				studioLeafId,
				artifactPath: path,
			}).catch((e) => console.warn('[wizard] handoff failed:', e));
		}
		clearTimeout(timeout);
		cleanup();
	}

	try {
		watcherId = await fsWatch(rootPath);
		console.info(
			'[wizard] watching',
			rootPath,
			'for .html under',
			normalizedPrefix,
			'(slug match:',
			slugLower,
			')'
		);
		unlisten = await fsListenWatch(watcherId, (change) => {
			if (cleaned) return;
			if (change.kind !== 'create') return;
			if (!change.path.toLowerCase().endsWith('.html')) return;
			if (!change.path.startsWith(`${normalizedPrefix}/`) && change.path !== normalizedPrefix) {
				return;
			}

			const basename = change.path
				.replace(/^.+\//, '')
				.replace(/\.html$/i, '')
				.toLowerCase();
			const isSlugMatch = slugLower.length > 0 && basename.includes(slugLower);

			if (isSlugMatch) {
				fire(change.path, 'slug-match');
				return;
			}

			// Non-matching create — hold as fallback. If the slug match
			// shows up before the grace window expires, that fire() will
			// cleanup() and the timer becomes a no-op via `cleaned`.
			if (!fallback) {
				fallback = { path: change.path };
				console.info(
					'[wizard] non-matching .html',
					change.path,
					'— holding as fallback for',
					FALLBACK_GRACE_MS,
					'ms'
				);
				fallbackTimer = setTimeout(() => {
					if (cleaned || !fallback) return;
					fire(fallback.path, 'fallback');
				}, FALLBACK_GRACE_MS);
			}
		});
	} catch (e) {
		console.warn('[wizard] could not watch', rootPath, e);
		clearTimeout(timeout);
	}
}

/** Swap the Studio leaf's active view from `density: 'grid'` (on the folder)
 *  to `density: 'loupe'` on the freshly-written file. Falls back to a new
 *  tab on the focused pane if the Studio leaf has been closed. */
function swapStudioToLoupe(studioLeafId: string, path: string): void {
	const ps = usePaneStore.getState();
	const view = { kind: 'artifact-studio' as const, path, density: 'loupe' as const };
	try {
		if (findLeaf(ps.root, studioLeafId)) {
			ps.replaceActiveViewAndPushHistory(studioLeafId, view);
		} else {
			ps.addTab(ps.focusedId, view);
		}
	} catch (e) {
		console.error('[wizard] auto-swap to loupe failed:', e);
	}
}

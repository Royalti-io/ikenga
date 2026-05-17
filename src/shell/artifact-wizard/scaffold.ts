// startArtifact — wires up the terminal + Studio loupe handoff.
//
// Flow:
//   1. Spawn `claude` in a terminal pane on the focused leaf, cwd = project
//      root so `.claude/skills/`, commands, and CLAUDE.md resolve.
//   2. Wait for the PTY id to land, then write the kickoff prompt into it
//      so claude sees the brief without the user having to paste anything.
//   3. Watch the chosen folder (via project-root recursive watcher with a
//      prefix filter) for the first new `.html` file. When one lands, open
//      a Studio loupe pointed at it next to the terminal pane.
//
// The watcher outlives the wizard component — fire-and-forget side effect
// with a 30-minute self-timeout so it doesn't leak if the agent never
// writes anything.

import { fsListenWatch, fsUnwatch, fsWatch, ptyWrite, type Project } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';
import { createTerminalSession } from '@/terminal/single-terminal';
import { useTerminalStore } from '@/terminal/session-store';
import { type Archetype, slugifyName } from '@/shell/artifact-wizard/archetypes';

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
}

export interface StartResult {
	terminalSessionId: string;
	slug: string;
	kickoffPrompt: string;
}

const WATCHER_TIMEOUT_MS = 30 * 60 * 1000;
const PTY_READY_TIMEOUT_MS = 10_000;
/** Delay between PTY-ready and prompt write. Gives claude time to render
 *  its splash and reach an input-ready state before we type. */
const PROMPT_TYPING_DELAY_MS = 1500;
/** Delay between bracketed paste end and the submit Enter. Without this
 *  claude's TUI batches the Enter into the paste payload and treats it as
 *  another newline instead of a submit. */
const POST_PASTE_DELAY_MS = 200;

export async function startArtifact(args: StartArgs): Promise<StartResult> {
	const slug = slugifyName(args.name);
	const kickoffPrompt = args.archetype.kickoffPrompt({
		project: {
			display_name: args.project.display_name,
			root_path: args.project.root_path,
		},
		slug,
	});

	// Spawn the terminal at the project root so claude sees the right
	// `.claude/` and CLAUDE.md. D3 + D9 in the projects-as-context plan.
	const cwd = args.project.root_path ?? args.folder;
	const terminalSessionId = createTerminalSession({
		cwd,
		cmd: ['claude'],
		title: `claude · ${args.archetype.label.toLowerCase()}`,
	});

	// Mount the terminal in the focused pane.
	const paneStore = usePaneStore.getState();
	paneStore.addTab(paneStore.focusedId, {
		kind: 'terminal',
		sessionId: terminalSessionId,
	});

	// Type the kickoff prompt into the PTY once it's ready. Fire and forget.
	void typeKickoff(terminalSessionId, kickoffPrompt);

	// Watch the project root recursively and pop the loupe when a new
	// .html lands under the chosen folder.
	if (args.project.root_path) {
		void watchForArtifact(args.project.root_path, args.folder);
	}

	return { terminalSessionId, slug, kickoffPrompt };
}

/** Wait for the PTY id to land in the session-store, give claude a beat to
 *  finish its splash, then bracket-paste the prompt and submit with a
 *  separate Enter keystroke.
 *
 *  Bracketed paste (`\x1b[200~ … \x1b[201~`) signals to claude's TUI input
 *  that the multi-line payload is a single pasted block — without it,
 *  embedded `\n`s in the prompt fire intermediate newlines and the trailing
 *  CR is absorbed as another newline instead of a submit. The follow-up
 *  `\r` after a short delay then submits cleanly. */
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

/** Watch the project root recursively for the first new `.html` whose path
 *  is under `folderPrefix`. Open the loupe and clean up the watcher.
 *  Self-terminates after 30 minutes if no match. */
async function watchForArtifact(rootPath: string, folderPrefix: string): Promise<void> {
	const normalizedPrefix = folderPrefix.replace(/\/+$/, '');
	let watcherId: string | null = null;
	let unlisten: (() => void) | null = null;
	let cleaned = false;

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
	}

	const timeout = setTimeout(cleanup, WATCHER_TIMEOUT_MS);

	try {
		watcherId = await fsWatch(rootPath);
		unlisten = await fsListenWatch(watcherId, (change) => {
			if (cleaned) return;
			if (change.kind !== 'create') return;
			if (!change.path.toLowerCase().endsWith('.html')) return;
			if (!change.path.startsWith(`${normalizedPrefix}/`) && change.path !== normalizedPrefix) {
				return;
			}
			try {
				const ps = usePaneStore.getState();
				ps.addTab(ps.focusedId, {
					kind: 'artifact-studio',
					path: change.path,
					density: 'loupe',
				});
			} catch (e) {
				console.error('[wizard] auto-open studio failed:', e);
			}
			clearTimeout(timeout);
			cleanup();
		});
	} catch (e) {
		console.warn('[wizard] could not watch', rootPath, e);
		clearTimeout(timeout);
	}
}

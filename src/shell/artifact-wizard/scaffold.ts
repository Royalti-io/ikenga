// startArtifact — wires up the chat + Studio loupe handoff for a new artifact.
//
// Flow:
//   1. Mint a chat thread tied to the active project + chosen archetype.
//   2. Open the thread as a chat pane on the focused leaf.
//   3. Auto-send the kickoff prompt so the agent starts answering immediately.
//   4. Watch the chosen folder (via project-root recursive watcher with a
//      prefix filter) for the first new `.html` file. When one lands, open
//      a Studio loupe pointed at it next to the chat pane.
//
// The watcher outlives the wizard component — it's spun up as a fire-and-
// forget side effect with a 30-minute self-timeout so it doesn't leak if
// the agent never writes anything.

import { mintThreadId, defaultChatAdapterId } from '@/chat';
import { createThread, appendUserTurn } from '@/chat/persist';
import { getAdapter } from '@/chat/registry';
import { useChatStore } from '@/chat/store';
import { fsListenWatch, fsUnwatch, fsWatch, sessionEnsure, type Project } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';
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
	threadId: string;
	slug: string;
	kickoffPrompt: string;
}

const WATCHER_TIMEOUT_MS = 30 * 60 * 1000;

export async function startArtifact(args: StartArgs): Promise<StartResult> {
	const slug = slugifyName(args.name);
	const kickoffPrompt = renderKickoff(args, slug);

	const threadId = mintThreadId();
	const adapterId = defaultChatAdapterId();
	const cwd = args.project.root_path ?? args.folder;
	const title = `${args.archetype.label}: ${args.name}`;
	const now = Date.now();

	// Register the Rust-side session row up front so the streaming child
	// can spawn on the first prompt (idempotent — adapter.attach also
	// calls this).
	await sessionEnsure(threadId, cwd, {});

	// Persist the thread so it survives a reload.
	await createThread({
		id: threadId,
		adapterId,
		cwd,
		claudeSessionId: null,
		model: null,
		title,
		projectId: args.project.id,
	});

	// Mirror into the in-memory store so the chat pane mounts with the
	// thread already known. Without this the pane has to wait for the
	// DB→store hydration loop, which races with the kickoff send below.
	useChatStore.getState().upsertThread({
		id: threadId,
		adapterId,
		title,
		cwd,
		model: null,
		claudeSessionId: null,
		ptyId: null,
		projectId: args.project.id,
		createdAt: now,
		updatedAt: now,
	});

	// Open the chat pane on the focused leaf. The user sees the agent
	// thinking immediately.
	const paneStore = usePaneStore.getState();
	paneStore.addTab(paneStore.focusedId, { kind: 'chat', sessionId: threadId });

	// Auto-send the kickoff prompt. Fire and forget — the chat UI shows
	// the streaming response as it arrives.
	void autoSend(threadId, adapterId, kickoffPrompt);

	// Watch the project root recursively and pop the loupe when a new
	// .html lands under the chosen folder. Project root always exists;
	// the folder may not yet.
	if (args.project.root_path) {
		void watchForArtifact(args.project.root_path, args.folder);
	}

	return { threadId, slug, kickoffPrompt };
}

function renderKickoff(args: StartArgs, slug: string): string {
	return args.archetype.kickoffPrompt({
		project: {
			display_name: args.project.display_name,
			root_path: args.project.root_path,
		},
		slug,
	});
}

async function autoSend(threadId: string, adapterId: string, text: string): Promise<void> {
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
				// drain — the adapter's own listeners persist + push events.
			}
		} finally {
			if (useChatStore.getState().threads[threadId]?.status === 'streaming') {
				useChatStore.getState().setStatus(threadId, 'idle');
			}
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error('[wizard] auto-send failed:', e);
		useChatStore.getState().setStatus(threadId, 'error', msg);
	}
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

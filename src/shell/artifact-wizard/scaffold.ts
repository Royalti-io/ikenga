// scaffoldArtifact — writes the starter HTML, opens the loupe, spawns the
// agent in a terminal attached to the focused Studio rail, and seeds the
// kickoff prompt for the user / agent.
//
// Phase C of plans/shell/2026-05-17-projects-and-artifact-wizard.md. The
// wizard's job is purely scaffolding; the agent owns the actual design (D4).
//
// Collision policy: if `<folder>/<slug>.html` exists, append `-2`, `-3`, …
// until a free slot is found (R-7 in the plan).

import { fsExists, fsWrite, type Project } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';
import { createTerminalSession } from '@/terminal/single-terminal';
import { useTerminalStore } from '@/terminal/session-store';
import {
	type Archetype,
	buildStarterTemplate,
	slugifyName,
} from '@/shell/artifact-wizard/archetypes';

export interface AgentChoice {
	kind: 'claude' | 'codex' | 'gemini' | 'custom';
	/** Display label for the terminal tab. */
	title: string;
	/** Command + args. For `'custom'`, the user supplies the executable path. */
	cmd: string[];
}

export interface ScaffoldArgs {
	project: Project;
	/** Absolute target directory. The wizard pre-fills this to
	 *  `<project.root_path>/<archetype.defaultSubdir>` but the user can
	 *  override. */
	folder: string;
	archetype: Archetype;
	/** Selected skill slugs (project + user). Surfaced in the kickoff prompt. */
	skills: string[];
	agent: AgentChoice;
	/** Display name. Slugified for the filename. */
	name: string;
	/** Optional free-text intent. Empty string = omitted from kickoff. */
	userIntent: string;
}

export interface ScaffoldResult {
	/** Absolute path to the freshly-written artifact HTML. */
	path: string;
	/** The slug actually used (may differ from `slugifyName(name)` if there
	 *  was a collision). */
	slug: string;
	/** Terminal session id, if a terminal was spawned. `null` when the user
	 *  picks `kind: 'custom'` with no resolved command. */
	terminalSessionId: string | null;
	/** Kickoff prompt rendered for this scaffold. The caller surfaces it as
	 *  a copy-paste block in the wizard's success state (see TODO at the
	 *  bottom of this file re: typing into the spawned terminal). */
	kickoffPrompt: string;
}

const FILENAME_MAX_TRIES = 50;

/** Pick a non-colliding slug under `folder`. Returns `<slug>` for the first
 *  free slot, falling back to `<slug>-<n>` for n = 2..FILENAME_MAX_TRIES. */
async function pickFreeSlug(folder: string, baseSlug: string): Promise<string> {
	for (let i = 1; i <= FILENAME_MAX_TRIES; i++) {
		const candidate = i === 1 ? baseSlug : `${baseSlug}-${i}`;
		const path = joinPath(folder, `${candidate}.html`);
		const exists = await fsExists(path).catch(() => false);
		if (!exists) return candidate;
	}
	// Last-resort: time-suffix. The user can rename in the manifest editor.
	return `${baseSlug}-${Date.now()}`;
}

function joinPath(folder: string, name: string): string {
	const cleaned = folder.replace(/\/+$/, '');
	return `${cleaned}/${name}`;
}

/** Open the freshly-scaffolded artifact in artifact-studio loupe density on
 *  the focused pane. Mirrors the `addTab` call sites in
 *  `src/shell/sidebar-modes/files-mode.tsx` and `loupe.tsx`. */
function openInStudio(path: string): void {
	const { focusedId, addTab } = usePaneStore.getState();
	addTab(focusedId, { kind: 'artifact-studio', path, density: 'loupe' });
}

export async function scaffoldArtifact(args: ScaffoldArgs): Promise<ScaffoldResult> {
	const baseSlug = slugifyName(args.name);
	const slug = await pickFreeSlug(args.folder, baseSlug);
	const filename = `${slug}.html`;
	const fullPath = joinPath(args.folder, filename);

	const html = buildStarterTemplate({
		name: args.name,
		slug,
		archetype: args.archetype.slug,
		viewport: args.archetype.viewport,
		userIntent: args.userIntent,
	});

	// `fs_write` creates parent directories automatically (see
	// src-tauri/src/commands/fs.rs:92) — no separate mkdir needed.
	const bytes = new TextEncoder().encode(html);
	await fsWrite(fullPath, bytes);

	// Open it in the focused pane as a Studio loupe so the user immediately
	// sees what they scaffolded.
	openInStudio(fullPath);

	// Render the kickoff prompt. The Studio rail attach popover is the
	// canonical way to wire a terminal into this loupe; spawning it here
	// puts the terminal into the sidepane pool, where the loupe's "Attach…"
	// chip picks it up. Per D3 + D9, cwd = active project root (which is
	// `args.project.root_path` at this point — the wizard's step 1 sets
	// active to the chosen project before reaching this step).
	const kickoffPrompt = args.archetype.kickoffPrompt({
		project: { display_name: args.project.display_name, root_path: args.project.root_path },
		folder: args.folder,
		slug,
		skills: args.skills,
		userIntent: args.userIntent,
	});

	let terminalSessionId: string | null = null;
	if (args.agent.cmd.length > 0) {
		const cwd = args.project.root_path ?? args.folder;
		terminalSessionId = createTerminalSession({
			cwd,
			cmd: args.agent.cmd,
			title: args.agent.title,
		});
		// Surface the new terminal as a sidepane-owned tab so the Studio
		// rail's Attach popover sees it immediately. The wizard exits here;
		// the user clicks Attach… on the loupe rail to bind it.
		// Re-export not needed — `createTerminalSession` already runs the
		// PTY spawn and registers the tab as sidepane-owned by default
		// (see src/terminal/single-terminal.tsx + session-store).
		void useTerminalStore.getState();
	}

	return {
		path: fullPath,
		slug,
		terminalSessionId,
		kickoffPrompt,
	};
}

// TODO(phase-c): the plan asks the wizard to "type the kickoff prompt into
// the spawned terminal." The terminal store exposes no public `type` /
// `writeStdin` API today — the only path is `pty_write` via the Rust side,
// but that is tied to a PTY id that may not exist yet at the moment the
// session is created (the PTY spawn is async; the id lands later). For
// Phase C we surface the kickoff prompt to the user as a copy-paste block
// in the wizard's success state instead. Follow-up: extend
// `useTerminalStore` with a `pendingInput` field that the SingleTerminal
// host drains on PTY-ready, so wizard-style prompts can be queued before
// the PTY exists.

// startArtifact — spawns the chosen agent in the project root with a
// kickoff prompt naming the archetype + suggested filename. The agent
// owns file creation, folder choice, and design (D4).
//
// Per the post-rewrite scope (2026-05-17): the wizard no longer writes
// files or opens the Studio loupe. It just briefs the agent and exits.

import { createTerminalSession } from '@/terminal/single-terminal';
import { type Archetype, slugifyName } from '@/shell/artifact-wizard/archetypes';
import type { Project } from '@/lib/tauri-cmd';

export interface StartArgs {
	project: Project;
	archetype: Archetype;
	/** Display name. Surfaced to the agent + slugified for the path hint. */
	name: string;
}

export interface StartResult {
	/** Suggested filename slug (no extension), passed into the kickoff prompt. */
	slug: string;
	/** Terminal session id for the spawned agent. */
	terminalSessionId: string;
	/** Kickoff prompt rendered for this start. The wizard surfaces it as a
	 *  copy-paste block so the user can drop it into the spawned terminal. */
	kickoffPrompt: string;
}

export async function startArtifact(args: StartArgs): Promise<StartResult> {
	const slug = slugifyName(args.name);

	const kickoffPrompt = args.archetype.kickoffPrompt({
		project: {
			display_name: args.project.display_name,
			root_path: args.project.root_path,
		},
		slug,
	});

	// Spawn claude at the project root so `.claude/skills/`, commands, and
	// CLAUDE.md resolve. Always claude — the agent picker was dropped to
	// keep the wizard a single screen. Users who want a different runtime
	// can spawn it manually from the Studio rail's Attach popover.
	const cwd = args.project.root_path ?? undefined;
	const terminalSessionId = createTerminalSession({
		cwd,
		cmd: ['claude'],
		title: 'claude',
	});

	return {
		slug,
		terminalSessionId,
		kickoffPrompt,
	};
}

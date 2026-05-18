/**
 * Slash-command discovery. Three tiers:
 *   * Built-in Claude Code commands — `/clear`, `/compact`, `/memory`,
 *     `/model`, `/login`, etc. — sourced from `builtin-slash-commands.ts`.
 *     Each carries an `action` describing what to do when picked (since
 *     stream-json mode can't execute them on the engine side).
 *   * `~/.claude/commands/*.md` — user-level custom commands.
 *   * `<cwd>/.claude/commands/*.md` — project-level custom commands.
 *
 * Names are derived from the file basename (`thing.md` → `/thing`).
 * Shadowing precedence (most specific wins): project > user > builtin.
 * That mirrors Claude Code's project-over-user resolution and lets users
 * override `/clear` etc. with their own .md file.
 */

import { useEffect, useState } from 'react';
import { fsList } from '@/lib/tauri-cmd';
import { loadHome } from '@/lib/home';
import { BUILTIN_SLASH_COMMANDS, type BuiltinAction } from './builtin-slash-commands';

export interface SlashCommand {
	name: string;
	source: 'user' | 'project' | 'builtin';
	/** Disk path for user/project commands; null for built-ins (whose
	 *  behavior is dispatched via `action` instead of file content). */
	path: string | null;
	/** Short human-readable description, rendered next to the name in
	 *  the popover. Only present for built-ins today; future per-`.md`
	 *  frontmatter parsing could populate this for user/project commands. */
	description?: string;
	/** Set only on built-ins. The composer dispatches on this instead of
	 *  inserting the command text into the textarea. */
	action?: BuiltinAction;
}

async function listMarkdown(dir: string): Promise<string[]> {
	try {
		const entries = await fsList(dir);
		return entries
			.filter((e) => !e.isDir && e.name.endsWith('.md'))
			.map((e) => e.name.replace(/\.md$/, ''));
	} catch {
		return [];
	}
}

export async function loadSlashCommands(cwd: string | null): Promise<SlashCommand[]> {
	const home = await loadHome();
	const userDir = `${home}/.claude/commands`;
	const [userNames, projectNames] = await Promise.all([
		listMarkdown(userDir),
		cwd ? listMarkdown(`${cwd}/.claude/commands`) : Promise.resolve([]),
	]);
	const byName = new Map<string, SlashCommand>();
	// Tier 1: built-ins — lowest precedence, user/project .md can shadow.
	for (const b of BUILTIN_SLASH_COMMANDS) {
		byName.set(b.name, {
			name: b.name,
			source: 'builtin',
			path: null,
			description: b.description,
			action: b.action,
		});
	}
	// Tier 2: user-level custom commands shadow built-ins of the same name.
	for (const n of userNames) {
		byName.set(n, { name: n, source: 'user', path: `${userDir}/${n}.md` });
	}
	// Tier 3: project-level commands shadow user + built-in.
	for (const n of projectNames) {
		byName.set(n, { name: n, source: 'project', path: `${cwd}/.claude/commands/${n}.md` });
	}
	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function useSlashCommands(cwd: string | null | undefined): SlashCommand[] {
	const [commands, setCommands] = useState<SlashCommand[]>([]);
	useEffect(() => {
		let cancelled = false;
		void loadSlashCommands(cwd ?? null).then((c) => {
			if (!cancelled) setCommands(c);
		});
		return () => {
			cancelled = true;
		};
	}, [cwd]);
	return commands;
}

/** Filter by the user's partial input. `query` is the slash command name as
 *  typed so far, without the leading `/`. Case-insensitive substring match;
 *  exact-prefix matches sort first. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
	if (!query) return commands.slice(0, 12);
	const q = query.toLowerCase();
	return commands
		.filter((c) => c.name.toLowerCase().includes(q))
		.sort((a, b) => {
			const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
			const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
			if (ap !== bp) return ap - bp;
			return a.name.localeCompare(b.name);
		})
		.slice(0, 12);
}

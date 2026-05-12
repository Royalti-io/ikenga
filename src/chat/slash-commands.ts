/**
 * Slash-command discovery. Reads Markdown command files from:
 *   * `~/.claude/commands/*.md` — user-level
 *   * `<cwd>/.claude/commands/*.md` — project-level
 *
 * Names are derived from the file basename (`thing.md` → `/thing`). Project
 * commands shadow user commands of the same name (Claude Code's actual
 * resolution order — `claude` itself prefers project commands).
 */

import { useEffect, useState } from 'react';
import { fsList } from '@/lib/tauri-cmd';
import { loadHome } from '@/lib/home';

export interface SlashCommand {
	name: string;
	source: 'user' | 'project';
	path: string;
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
	for (const n of userNames) {
		byName.set(n, { name: n, source: 'user', path: `${userDir}/${n}.md` });
	}
	for (const n of projectNames) {
		// project shadows user
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

// Sync cwd resolver for agent / terminal / chat spawns.
//
// Per D3 + D9 in plans/shell/2026-05-17-projects-and-artifact-wizard.md:
// agent cwd = active project's root_path, so `.claude/skills/`, commands,
// CLAUDE.md, and project-scoped MCP servers resolve. Falls back to
// `defaultCwd()` when no active project is set, or its root_path is null
// (the seed Default project has no root_path).

import { defaultCwd } from './default-cwd';
import { useShellStore } from './shell-store';

export function activeProjectCwd(): string {
	const s = useShellStore.getState();
	const active = s.projects.find((p) => p.id === s.activeProjectId);
	return active?.root_path ?? defaultCwd();
}

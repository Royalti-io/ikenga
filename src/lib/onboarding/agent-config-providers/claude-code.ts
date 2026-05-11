// Claude Code provider — `~/.claude/` + project-local `.claude/` layout.
//
// The actual file walk lives in Rust (src-tauri/src/agent_detect/scaffold.rs)
// so the templates can be embedded into the release binary via include_dir!.
// This module is the typed TS-side adapter that the wizard talks to.

import { detectAgentConfig, scaffoldAgentConfig } from '@/lib/tauri-cmd';

import type { AgentConfigProvider, ScaffoldResult } from './types';
import { toProviderInventory } from './types';

export const claudeCodeProvider: AgentConfigProvider = {
	agentId: 'claude-code',
	paths: {
		configDir: '.claude',
		agents: '.claude/agents',
		skills: '.claude/skills',
		commands: '.claude/commands',
		// Claude Code stores MCP servers in `~/.claude.json` (user-global)
		// rather than a project-local file. Left undefined intentionally.
	},
	profiles: [
		{
			id: 'starter',
			label: 'Music label starter',
			description:
				'Release coordination, outbound writing, and content curation — generalised templates with no organisation-specific references.',
			// Counts mirror the bundled templates (kept manually in sync;
			// not load-bearing — the preview is informational).
			counts: { agents: 3, skills: 6, commands: 3 },
		},
	],
	async inventory(rootPath) {
		const raw = await detectAgentConfig('claude-code', rootPath);
		return toProviderInventory(raw);
	},
	async scaffold(rootPath, profileId, mode): Promise<ScaffoldResult> {
		const raw = await scaffoldAgentConfig('claude-code', rootPath, profileId, mode);
		return {
			ok: raw.ok,
			filesWritten: raw.files_written,
			message: raw.message,
			written: raw.written ?? [],
			skipped: raw.skipped ?? [],
			errors: raw.errors ?? [],
		};
	},
};

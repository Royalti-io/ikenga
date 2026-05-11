// Phase 6 — agent-config provider abstraction.
//
// Every coding-agent CLI (Claude Code, Codex, Cursor, Gemini, …) ships
// the same conceptual triple: agents, skills, commands. They disagree
// on file paths and frontmatter. The wizard step is provider-agnostic
// — it asks the registered provider for inventory, plan, scaffold, and
// renders the result the same way regardless of agent.
//
// v1 registers exactly one provider: `claude-code`.
//
// TODO (post-v1, additive — no changes to this file required):
//   - `codex` provider — `~/.codex/agents.json` layout.
//   - `cursor` provider — `.cursor/rules/*.mdc` layout.
//   - `gemini` provider — emerging; track upstream conventions before
//     committing to a path.

import type { AgentConfigInventory } from '@/lib/tauri-cmd';

/** Maps onto onboarding.selectedAgentId. */
export type ProviderId = 'claude-code' | (string & {});

export interface ProviderPaths {
	/** The dotted config dir, relative to project root. */
	configDir: string; // '.claude'
	/** Where agent definition files live (.md by convention). */
	agents: string; // '.claude/agents'
	/** Where skill directories live (each contains SKILL.md). */
	skills: string; // '.claude/skills'
	/** Where slash-command files live (.md by convention). */
	commands: string; // '.claude/commands'
	/** Optional MCP config file path. */
	mcp?: string; // '.claude/mcp.json' (none for claude-code today — it uses ~/.claude.json)
}

export interface ScaffoldProfile {
	id: string; // 'starter' | (future) 'music-label' | 'studio'
	label: string;
	description: string;
	/** Approximate counts the preview UI surfaces — not load-bearing. */
	counts: { agents: number; skills: number; commands: number };
}

export interface ProviderInventory {
	configDirPresent: boolean;
	agentCount: number;
	skillCount: number;
	commandCount: number;
	mcpServerCount: number;
}

/** Mirrors the Rust ScaffoldMode. */
export type ScaffoldMode = 'replace' | 'augment' | 'skip_conflicts';

/** Mirrors the Rust ScaffoldResponse. */
export interface ScaffoldResult {
	ok: boolean;
	filesWritten: number;
	message: string;
	written: string[];
	skipped: { path: string; reason: string }[];
	errors: { path: string; reason: string }[];
}

export interface AgentConfigProvider {
	/** Matches DetectedAgent.id. */
	agentId: ProviderId;
	/** Path conventions for this provider, relative to root_path. */
	paths: ProviderPaths;
	/** Available profiles to scaffold. */
	profiles: ScaffoldProfile[];
	/** Inventory existing config without touching it. */
	inventory(rootPath: string): Promise<ProviderInventory>;
	/** Execute a scaffold via the Tauri command. */
	scaffold(rootPath: string, profileId: string, mode: ScaffoldMode): Promise<ScaffoldResult>;
}

/** Normalise the raw Tauri AgentConfigInventory into the provider shape. */
export function toProviderInventory(raw: AgentConfigInventory): ProviderInventory {
	return {
		configDirPresent: raw.config_dir_present,
		agentCount: raw.agent_count,
		skillCount: raw.skill_count,
		commandCount: raw.command_count,
		mcpServerCount: raw.mcp_server_count,
	};
}

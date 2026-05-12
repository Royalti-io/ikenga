// Provider abstraction tests. The Rust side is covered by `cargo test
// agent_detect::scaffold` — these tests verify the TS adapter and the
// registry.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories MUST be hoisted; declare the spies inside the factory
// callback so they're available when the module under test imports
// tauri-cmd. We re-import them via `await import` below.
vi.mock('@/lib/tauri-cmd', () => ({
	detectAgentConfig: vi.fn(),
	scaffoldAgentConfig: vi.fn(),
}));

import { detectAgentConfig, scaffoldAgentConfig } from '@/lib/tauri-cmd';

import { getProvider, listProviders } from './registry';
import { claudeCodeProvider } from './claude-code';

const mockedDetect = vi.mocked(detectAgentConfig);
const mockedScaffold = vi.mocked(scaffoldAgentConfig);

beforeEach(() => {
	mockedDetect.mockReset();
	mockedScaffold.mockReset();
});

describe('agent-config-providers / registry', () => {
	it('registers claude-code by default', () => {
		const p = getProvider('claude-code');
		expect(p).not.toBeNull();
		expect(p?.agentId).toBe('claude-code');
	});

	it('returns null for unknown agent', () => {
		expect(getProvider('codex')).toBeNull();
		expect(getProvider(null)).toBeNull();
		expect(getProvider(undefined)).toBeNull();
	});

	it('listProviders includes the claude-code provider', () => {
		const ids = listProviders().map((p) => p.agentId);
		expect(ids).toContain('claude-code');
	});
});

describe('claudeCodeProvider', () => {
	it('declares standard .claude/ paths', () => {
		expect(claudeCodeProvider.paths).toMatchObject({
			configDir: '.claude',
			agents: '.claude/agents',
			skills: '.claude/skills',
			commands: '.claude/commands',
		});
	});

	it('exposes a starter profile with non-zero counts', () => {
		const starter = claudeCodeProvider.profiles.find((p) => p.id === 'starter');
		expect(starter).toBeDefined();
		expect(starter?.counts.agents).toBeGreaterThan(0);
		expect(starter?.counts.skills).toBeGreaterThan(0);
		expect(starter?.counts.commands).toBeGreaterThan(0);
	});

	it('inventory() normalises Tauri snake_case → provider camelCase', async () => {
		mockedDetect.mockResolvedValueOnce({
			root_path: '/tmp/x',
			config_dir_present: true,
			agent_count: 2,
			skill_count: 7,
			command_count: 4,
			mcp_server_count: 3,
			project_count: 1,
		});
		const inv = await claudeCodeProvider.inventory('/tmp/x');
		expect(inv).toEqual({
			configDirPresent: true,
			agentCount: 2,
			skillCount: 7,
			commandCount: 4,
			mcpServerCount: 3,
		});
		expect(mockedDetect).toHaveBeenCalledWith('claude-code', '/tmp/x');
	});

	it('scaffold() forwards provider/profile/mode to the Tauri command', async () => {
		mockedScaffold.mockResolvedValueOnce({
			ok: true,
			files_written: 11,
			message: 'wrote 11 file(s); skipped 0 existing',
			written: ['agents/a.md'],
			skipped: [],
			errors: [],
		});
		const res = await claudeCodeProvider.scaffold('/tmp/root', 'starter', 'augment');
		expect(mockedScaffold).toHaveBeenCalledWith('claude-code', '/tmp/root', 'starter', 'augment');
		expect(res.ok).toBe(true);
		expect(res.filesWritten).toBe(11);
		expect(res.written).toEqual(['agents/a.md']);
	});

	it('scaffold() surfaces errors/skipped from the Tauri response', async () => {
		mockedScaffold.mockResolvedValueOnce({
			ok: false,
			files_written: 1,
			message: 'partial',
			written: ['agents/ok.md'],
			skipped: [{ path: 'skills/x', reason: 'exists' }],
			errors: [{ path: 'agents/bad.md', reason: 'EACCES' }],
		});
		const res = await claudeCodeProvider.scaffold('/tmp/root', 'starter', 'replace');
		expect(res.ok).toBe(false);
		expect(res.skipped[0]).toEqual({ path: 'skills/x', reason: 'exists' });
		expect(res.errors[0]).toEqual({ path: 'agents/bad.md', reason: 'EACCES' });
	});

	it('scaffold() tolerates missing optional arrays', async () => {
		// Older Rust builds might omit fields; the adapter should default.
		mockedScaffold.mockResolvedValueOnce({
			ok: true,
			files_written: 0,
			message: 'noop',
		} as unknown as {
			ok: boolean;
			files_written: number;
			message: string;
			written: string[];
			skipped: never[];
			errors: never[];
		});
		const res = await claudeCodeProvider.scaffold('/tmp/root', 'starter', 'augment');
		expect(res.written).toEqual([]);
		expect(res.skipped).toEqual([]);
		expect(res.errors).toEqual([]);
	});
});

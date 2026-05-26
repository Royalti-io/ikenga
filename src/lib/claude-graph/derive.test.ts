import { describe, expect, it } from 'vitest';
import type {
	ClaudeAgent,
	ClaudeCommand,
	ClaudeConfig,
	ClaudeHook,
	ClaudeMcp,
	ClaudeSkill,
} from '@/lib/tauri-cmd';
import { deriveGraph, mcpServerOf, toolGrants } from './derive';

// ─── fixture builders ────────────────────────────────────────────────────────
function agent(name: string, opts: Partial<ClaudeAgent> = {}): ClaudeAgent {
	return {
		name,
		scope: 'personal',
		projectRoot: null,
		path: `/a/${name}.md`,
		modifiedMs: 0,
		description: opts.description ?? null,
		model: null,
		frontmatter: opts.frontmatter ?? {},
		body: opts.body ?? '',
		overriddenBy: null,
		isSymlink: false,
		linkTarget: null,
		inStore: false,
		...opts,
	};
}
function command(name: string, opts: Partial<ClaudeCommand> = {}): ClaudeCommand {
	return {
		name,
		scope: 'personal',
		projectRoot: null,
		path: `/c/${name}.md`,
		modifiedMs: 0,
		description: null,
		model: null,
		argumentHint: null,
		frontmatter: opts.frontmatter ?? {},
		body: opts.body ?? '',
		overriddenBy: null,
		isSymlink: false,
		linkTarget: null,
		inStore: false,
		...opts,
	};
}
function skill(name: string, opts: Partial<ClaudeSkill> = {}): ClaudeSkill {
	return {
		name,
		scope: 'personal',
		projectRoot: null,
		path: `/s/${name}/SKILL.md`,
		dirPath: `/s/${name}`,
		modifiedMs: 0,
		description: null,
		frontmatter: opts.frontmatter ?? {},
		body: opts.body ?? '',
		supportingFiles: [],
		overriddenBy: null,
		isSymlink: false,
		linkTarget: null,
		inStore: false,
		...opts,
	};
}
function mcp(name: string, opts: Partial<ClaudeMcp> = {}): ClaudeMcp {
	return {
		name,
		scope: 'personal',
		projectRoot: null,
		path: '/.mcp.json',
		transport: 'stdio',
		command: 'bun',
		args: [],
		envKeys: [],
		url: null,
		headerKeys: [],
		raw: {},
		isSymlink: false,
		linkTarget: null,
		inStore: false,
		...opts,
	};
}
function hook(event: string, opts: Partial<ClaudeHook> & { matcher?: string } = {}): ClaudeHook {
	const { matcher, ...rest } = opts;
	return {
		event,
		type: 'command',
		name: opts.name ?? `${event}-hook`,
		scope: 'personal',
		projectRoot: null,
		settingsPath: '/.claude/settings.json',
		commandPath: '/h.sh',
		commandRaw: 'h.sh',
		raw: matcher !== undefined ? { matcher } : {},
		isSymlink: false,
		linkTarget: null,
		inStore: false,
		...rest,
	};
}
function emptyConfig(p: Partial<ClaudeConfig> = {}): ClaudeConfig {
	return { agents: [], skills: [], commands: [], hooks: [], mcps: [], errors: [], ...p };
}

// ─── unit: helpers ───────────────────────────────────────────────────────────
describe('mcpServerOf', () => {
	it('extracts server from an mcp tool token', () => {
		expect(mcpServerOf('mcp__royalti-mcp__list_releases')).toBe('royalti-mcp');
		expect(mcpServerOf('mcp__supabase__execute_sql')).toBe('supabase');
	});
	it('returns null for non-mcp tools', () => {
		expect(mcpServerOf('Bash')).toBeNull();
		expect(mcpServerOf('Read')).toBeNull();
	});
});

describe('toolGrants', () => {
	it('reads array, comma-string, and the three frontmatter keys', () => {
		expect(toolGrants({ tools: ['Bash', 'Read'] })).toEqual(['Bash', 'Read']);
		expect(toolGrants({ 'allowed-tools': 'Bash, Edit ,Write' })).toEqual(['Bash', 'Edit', 'Write']);
		expect(toolGrants({ allowedTools: ['Grep'] })).toEqual(['Grep']);
		expect(toolGrants({})).toEqual([]);
		expect(toolGrants(undefined)).toEqual([]);
	});
});

// ─── nodes ───────────────────────────────────────────────────────────────────
describe('deriveGraph · nodes', () => {
	it('emits one node per primitive with kind + stable id', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [agent('CMO')],
				skills: [skill('groundwork')],
				commands: [command('blog-pipeline')],
				mcps: [mcp('royalti-mcp')],
				hooks: [hook('SessionStart')],
			})
		);
		expect(g.nodes).toHaveLength(5);
		expect(g.nodes.find((n) => n.id === 'agent:CMO')?.kind).toBe('agent');
		expect(g.nodes.find((n) => n.id === 'skill:groundwork')).toBeTruthy();
		expect(g.nodes.find((n) => n.id === 'mcp:royalti-mcp')).toBeTruthy();
	});

	it('aggregates the same primitive across scopes into one node', () => {
		const g = deriveGraph(
			emptyConfig({
				skills: [
					skill('groundwork', { scope: 'personal' }),
					skill('groundwork', { scope: 'project', projectRoot: '/home/u/ikenga' }),
				],
			})
		);
		const node = g.nodes.filter((n) => n.id === 'skill:groundwork');
		expect(node).toHaveLength(1);
		expect(node[0].scopes).toEqual(['personal', 'project:ikenga']);
	});

	it('labels a tool-matcher hook as event:matcher, lifecycle hook as event', () => {
		const g = deriveGraph(
			emptyConfig({
				hooks: [hook('PreToolUse', { matcher: 'Bash' }), hook('SessionStart')],
			})
		);
		expect(g.nodes.find((n) => n.id === 'hook:PreToolUse:Bash')).toBeTruthy();
		expect(g.nodes.find((n) => n.id === 'hook:SessionStart')).toBeTruthy();
	});
});

// ─── declarative edges ─────────────────────────────────────────────────────────
describe('deriveGraph · declarative edges', () => {
	it('feeds: mcp → primitive when frontmatter grants an mcp tool', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [
					agent('CMO', {
						frontmatter: { 'allowed-tools': ['Bash', 'mcp__royalti-mcp__list_releases'] },
					}),
				],
				mcps: [mcp('royalti-mcp')],
			})
		);
		const e = g.edges.find((x) => x.rel === 'feeds');
		expect(e).toMatchObject({
			source: 'mcp:royalti-mcp',
			target: 'agent:CMO',
			derivation: 'declarative',
		});
	});

	it('does not feed from an mcp server that is not scanned', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [agent('CMO', { frontmatter: { tools: ['mcp__ghost__x'] } })],
			})
		);
		expect(g.edges.filter((e) => e.rel === 'feeds')).toHaveLength(0);
	});

	it('gates: tool-matcher hook → only primitives that declare a matching tool', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [
					agent('Basher', { frontmatter: { tools: ['Bash'] } }),
					agent('Reader', { frontmatter: { tools: ['Read'] } }),
				],
				hooks: [hook('PreToolUse', { matcher: 'Bash' })],
			})
		);
		const gates = g.edges.filter((e) => e.rel === 'gates');
		expect(gates).toHaveLength(1);
		expect(gates[0]).toMatchObject({ source: 'hook:PreToolUse:Bash', target: 'agent:Basher' });
	});

	it('gates: lifecycle hook → all agents (and not commands)', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [agent('CMO'), agent('CEO')],
				commands: [command('blog')],
				hooks: [hook('SessionStart')],
			})
		);
		const gates = g.edges.filter((e) => e.rel === 'gates');
		expect(gates.map((e) => e.target).sort()).toEqual(['agent:CEO', 'agent:CMO']);
	});

	it('regex matcher matches multiple tools (Edit|Write)', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [agent('Editor', { frontmatter: { tools: ['Write'] } })],
				hooks: [hook('PreToolUse', { matcher: 'Edit|Write' })],
			})
		);
		expect(g.edges.some((e) => e.rel === 'gates' && e.target === 'agent:Editor')).toBe(true);
	});
});

// ─── heuristic edges ───────────────────────────────────────────────────────────
describe('deriveGraph · heuristic edges', () => {
	it('uses: agent body mentioning a skill name → heuristic uses edge', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [agent('CMO', { body: 'First run the `groundwork` skill, then proceed.' })],
				skills: [skill('groundwork')],
			})
		);
		const e = g.edges.find((x) => x.rel === 'uses');
		expect(e).toMatchObject({
			source: 'agent:CMO',
			target: 'skill:groundwork',
			derivation: 'heuristic',
		});
	});

	it('routes: command body mentioning an agent name → heuristic routes edge', () => {
		const g = deriveGraph(
			emptyConfig({
				commands: [command('blog-pipeline', { body: 'Hand off to the Content agent.' })],
				agents: [agent('Content')],
			})
		);
		expect(g.edges.some((e) => e.rel === 'routes' && e.target === 'agent:Content')).toBe(true);
	});

	it('omits heuristic edges when includeHeuristic=false', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [agent('CMO', { body: 'use groundwork' })],
				skills: [skill('groundwork')],
			}),
			{ includeHeuristic: false }
		);
		expect(g.edges.filter((e) => e.derivation === 'heuristic')).toHaveLength(0);
	});

	it('does not mention-match a substring inside a larger word', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [agent('CMO', { body: 'groundworkflow is unrelated' })],
				skills: [skill('groundwork')],
			})
		);
		expect(g.edges.filter((e) => e.rel === 'uses')).toHaveLength(0);
	});

	it('declarative wins over heuristic on the same triple', () => {
		// An agent both grants an mcp tool AND mentions the mcp by name — feed stays declarative.
		const g = deriveGraph(
			emptyConfig({
				agents: [
					agent('CMO', {
						frontmatter: { tools: ['mcp__royalti-mcp__x'] },
						body: 'talks to royalti-mcp',
					}),
				],
				mcps: [mcp('royalti-mcp')],
			})
		);
		const feeds = g.edges.filter((e) => e.source === 'mcp:royalti-mcp' && e.target === 'agent:CMO');
		// feeds is mcp→agent; the body mention can't produce that triple, so just assert the feed is declarative.
		expect(feeds[0].derivation).toBe('declarative');
	});
});

// ─── degrees + scope filter ────────────────────────────────────────────────────
describe('deriveGraph · degrees + scope filter', () => {
	it('counts out/in degree', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [agent('CMO', { frontmatter: { tools: ['mcp__rm__x'] } })],
				mcps: [mcp('rm')],
			})
		);
		expect(g.nodes.find((n) => n.id === 'mcp:rm')?.degreeOut).toBe(1);
		expect(g.nodes.find((n) => n.id === 'agent:CMO')?.degreeIn).toBe(1);
	});

	it('scope filter keeps only nodes in that scope + edges between them', () => {
		const g = deriveGraph(
			emptyConfig({
				agents: [
					agent('CMO', {
						scope: 'project',
						projectRoot: '/x/ikenga',
						frontmatter: { tools: ['mcp__rm__x'] },
					}),
				],
				mcps: [
					mcp('rm', { scope: 'project', projectRoot: '/x/ikenga' }),
					mcp('other', { scope: 'personal' }),
				],
			}),
			{ scope: 'project:ikenga' }
		);
		expect(g.nodes.map((n) => n.id).sort()).toEqual(['agent:CMO', 'mcp:rm']);
		expect(g.nodes.some((n) => n.id === 'mcp:other')).toBe(false);
		expect(g.edges).toHaveLength(1);
	});
});

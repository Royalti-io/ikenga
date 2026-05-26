import { describe, expect, it } from 'vitest';
import type { ClaudeAgent, ClaudeCommand, ClaudeConfig, ClaudeSkill } from '@/lib/tauri-cmd';
import { buildFlowable, deriveFlow, extractRefs } from './flow';

// ─── fixture builders (mirror derive.test.ts) ────────────────────────────────
function command(name: string, body: string, opts: Partial<ClaudeCommand> = {}): ClaudeCommand {
	return {
		name,
		scope: 'personal',
		projectRoot: null,
		path: `/c/${name}.md`,
		modifiedMs: 0,
		description: null,
		model: null,
		argumentHint: null,
		frontmatter: {},
		body,
		overriddenBy: null,
		isSymlink: false,
		linkTarget: null,
		inStore: false,
		...opts,
	};
}
function agent(name: string, body: string): ClaudeAgent {
	return {
		name,
		scope: 'personal',
		projectRoot: null,
		path: `/a/${name}.md`,
		modifiedMs: 0,
		description: null,
		model: null,
		frontmatter: {},
		body,
		overriddenBy: null,
		isSymlink: false,
		linkTarget: null,
		inStore: false,
	};
}
function skill(name: string, body: string): ClaudeSkill {
	return {
		name,
		scope: 'personal',
		projectRoot: null,
		path: `/s/${name}/SKILL.md`,
		dirPath: `/s/${name}`,
		modifiedMs: 0,
		description: null,
		frontmatter: {},
		body,
		supportingFiles: [],
		overriddenBy: null,
		isSymlink: false,
		linkTarget: null,
		inStore: false,
	};
}
function config(p: Partial<ClaudeConfig> = {}): ClaudeConfig {
	return { agents: [], skills: [], commands: [], hooks: [], mcps: [], errors: [], ...p };
}

const prim = (kind: 'command' | 'agent' | 'skill', name: string, body: string) => ({
	kind,
	name,
	scope: 'personal',
	body,
});

describe('extractRefs', () => {
	it('pulls Task subagent dispatches as agent refs', () => {
		const refs = extractRefs('then Task(subagent_type="reviewer", prompt="x")');
		expect(refs).toContainEqual({ kind: 'agent', name: 'reviewer' });
	});
	it('pulls Skill() calls and `skill:` mentions', () => {
		expect(extractRefs('Skill("huashu-design")')).toContainEqual({
			kind: 'skill',
			name: 'huashu-design',
		});
		expect(extractRefs('via skill: editorial-standards')).toContainEqual({
			kind: 'skill',
			name: 'editorial-standards',
		});
	});
	it('pulls slash-commands, mcp tools, and bare built-in tools', () => {
		const refs = extractRefs('run /blog-pipeline, then mcp__royalti-cms__createPosts and Write');
		expect(refs).toContainEqual({ kind: 'command', name: 'blog-pipeline' });
		expect(refs).toContainEqual({ kind: 'mcp', name: 'royalti-cms' });
		expect(refs).toContainEqual({ kind: 'tool', name: 'Write' });
	});
	it('dedupes by kind:name, preserving first-seen order', () => {
		const refs = extractRefs('Write then Read then Write again');
		expect(refs.filter((r) => r.name === 'Write')).toHaveLength(1);
		expect(refs.map((r) => r.name)).toEqual(['Write', 'Read']);
	});
	it('matches known skill/agent names mentioned in prose', () => {
		const refs = extractRefs('first consult the groundwork skill', {
			skills: new Set(['groundwork']),
		});
		expect(refs).toContainEqual({ kind: 'skill', name: 'groundwork' });
	});
});

describe('deriveFlow', () => {
	it('extracts numbered steps with per-step refs', () => {
		const body = [
			'Do the work:',
			'1. Research the topic with WebSearch',
			'2. Draft via skill: editorial-standards',
			'3. Publish with mcp__royalti-cms__createPosts',
		].join('\n');
		const m = deriveFlow(prim('command', 'blog', body));
		expect(m.derivation).toBe('numbered');
		expect(m.steps).toHaveLength(3);
		expect(m.steps[0]).toMatchObject({ n: 1, label: 'Research the topic with WebSearch' });
		expect(m.steps[0].refs).toContainEqual({ kind: 'tool', name: 'WebSearch' });
		expect(m.steps[1].refs).toContainEqual({ kind: 'skill', name: 'editorial-standards' });
		expect(m.steps[2].refs).toContainEqual({ kind: 'mcp', name: 'royalti-cms' });
	});

	it('attributes sub-bullet refs to their owning numbered step', () => {
		const body = ['1. Plan it', '   - then Task(subagent_type="planner")', '2. Build it'].join(
			'\n'
		);
		const m = deriveFlow(prim('command', 'x', body));
		expect(m.steps[0].refs).toContainEqual({ kind: 'agent', name: 'planner' });
	});

	it('falls back to mention-order steps when there is no numbered list', () => {
		const body = 'First Task(subagent_type="rex"), then run /pa and Skill("verify").';
		const m = deriveFlow(prim('agent', 'router', body));
		expect(m.derivation).toBe('mentions');
		expect(m.steps.map((s) => s.label)).toEqual([
			'delegates to rex',
			'runs command pa',
			'invokes skill verify',
		]);
	});

	it('flags a loop when the body says it loops back', () => {
		const body = '1. design\n2. review — loops back to design until locked\n3. ship';
		expect(deriveFlow(prim('skill', 'gw', body)).loop).toBe(true);
		expect(deriveFlow(prim('skill', 'lin', '1. a\n2. b\n3. c')).loop).toBe(false);
	});

	it('yields zero steps for a body with no procedure or dispatches', () => {
		expect(
			deriveFlow(prim('command', 'empty', 'Just some prose, nothing actionable.')).steps
		).toEqual([]);
	});

	it('does not treat a single numbered line as a sequence (needs ≥2)', () => {
		// one "1." but a Task dispatch → mentions fallback, not numbered.
		const m = deriveFlow(prim('command', 'x', '1. only one\nlater Task(subagent_type="a")'));
		expect(m.derivation).toBe('mentions');
	});
});

describe('buildFlowable', () => {
	it('lists only primitives with ≥1 step, sorted command→agent→skill then name', () => {
		const cfg = config({
			commands: [command('zeta', '1. step a\n2. step b'), command('prose-only', 'nothing here')],
			agents: [agent('router', 'Task(subagent_type="x")')],
			skills: [skill('alpha', '1. one\n2. two')],
		});
		const entries = buildFlowable(cfg);
		expect(entries.map((e) => e.key)).toEqual(['command:zeta', 'agent:router', 'skill:alpha']);
	});

	it('aggregates a name across scopes, keeping the richest body', () => {
		const cfg = config({
			commands: [
				command('dup', '1. a\n2. b', { scope: 'personal' }),
				command('dup', '1. a\n2. b\n3. c\n4. d', {
					scope: 'project',
					projectRoot: '/p/ikenga',
				}),
			],
		});
		const entries = buildFlowable(cfg);
		expect(entries).toHaveLength(1);
		expect(entries[0].model.steps).toHaveLength(4);
	});
});

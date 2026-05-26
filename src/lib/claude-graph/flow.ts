// Orchestration flow extraction (Phase 4 · D-03 "Flow" view) — REGEX-ONLY first
// cut. Parses a primitive's body for the *procedural* step-sequence: numbered
// steps, `Task(subagent_type=…)` dispatches, `Skill()` / `skill:` mentions,
// slash-commands, and `mcp__server__*` tools.
//
// This is a SEPARATE concern from `deriveGraph` (G-EDGE): that derives the
// *declarative / body-mention* edge graph; this derives the *ordered* step
// sequence inside one body. It lives in its own module so the frozen graph
// contract is never touched. If regex proves too thin in practice, a one-time
// LLM read is the documented escalation (not done here).

import type { ClaudeConfig } from '@/lib/tauri-cmd';

export type FlowRefKind = 'agent' | 'skill' | 'command' | 'mcp' | 'tool';
export type FlowSourceKind = 'command' | 'agent' | 'skill';

export interface FlowRef {
	kind: FlowRefKind;
	name: string;
}
export interface FlowStep {
	/** 1-based order in the sequence. */
	n: number;
	/** The step text (cleaned, single line). */
	label: string;
	/** Skills / agents / commands / MCPs / tools invoked within this step. */
	refs: FlowRef[];
}
export interface FlowModel {
	source: { kind: FlowSourceKind; name: string; scope: string };
	steps: FlowStep[];
	/** How the steps were found: explicit numbered list, or mention-order fallback. */
	derivation: 'numbered' | 'mentions';
	/** Body language suggests the sequence loops back. */
	loop: boolean;
}
/** A flowable primitive (≥1 extractable step), keyed for the picker. */
export interface FlowEntry {
	key: string; // `${kind}:${name}`
	kind: FlowSourceKind;
	name: string;
	scope: string;
	model: FlowModel;
}

interface FlowPrimitive {
	kind: FlowSourceKind;
	name: string;
	scope: string;
	body: string;
}

/** Built-in tool names recognised as bare-word refs (Task is handled separately
 *  via its `subagent_type` arg). */
const TOOL_NAMES = [
	'Bash',
	'Read',
	'Write',
	'Edit',
	'MultiEdit',
	'Glob',
	'Grep',
	'WebSearch',
	'WebFetch',
	'NotebookEdit',
	'TodoWrite',
	'AskUserQuestion',
];
const TOOL_RE = new RegExp(`\\b(${TOOL_NAMES.join('|')})\\b`, 'g');
const TASK_RE = /Task\([^)]*?subagent_type\s*[=:]\s*['"]?([A-Za-z0-9_-]+)/g;
const SKILL_CALL_RE = /Skill\([^)]*?['"]([A-Za-z0-9_:-]+)['"]/g;
const SKILL_WORD_RE = /\bskill:\s*`?([A-Za-z0-9_/-]+)`?/gi;
// Slash-command: `/name` (≥2 chars), not a file path — the trailing lookahead
// rejects `/home/x` (next char is `/`) and longer-word runs.
const SLASH_RE = /(?:^|[\s(])\/([a-z][a-z0-9-]+)(?![/\w])/g;
const MCP_RE = /mcp__([a-z0-9-]+)__[a-z0-9_]+/gi;
const LOOP_RE =
	/\b(loops? back|loop back|repeat|iterate|re-?run|until (?:the )?\w+|each (?:iteration|cycle|round))\b/i;

function scopeKey(scope: 'project' | 'personal', projectRoot: string | null): string {
	if (scope === 'personal') return 'personal';
	const base = (projectRoot ?? '').split('/').filter(Boolean).pop() ?? 'project';
	return `project:${base}`;
}

/** Strip light markdown from a step label + collapse to one line. */
function cleanLabel(s: string): string {
	let out = s.trim();
	out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // [txt](url) → txt
	out = out.replace(/[*_`]+/g, ''); // bold/italic/code ticks
	out = out.replace(/\s+/g, ' ').trim();
	out = out.replace(/[:：]\s*$/, ''); // trailing colon
	return out.length > 120 ? `${out.slice(0, 117)}…` : out;
}

/** Extract distinct refs from a text span, in document-position order (so the
 *  mention-order fallback reads "first X, then Y"). Deduped by `kind:name`,
 *  keeping the earliest occurrence. */
export function extractRefs(
	text: string,
	known?: { agents?: Set<string>; skills?: Set<string> }
): FlowRef[] {
	const hits: { kind: FlowRefKind; name: string; idx: number }[] = [];
	const run = (re: RegExp, kind: FlowRefKind, normalize?: (s: string) => string) => {
		re.lastIndex = 0;
		for (let m = re.exec(text); m; m = re.exec(text)) {
			const name = normalize ? normalize(m[1]) : m[1];
			if (name) hits.push({ kind, name, idx: m.index });
		}
	};
	run(TASK_RE, 'agent');
	run(SKILL_CALL_RE, 'skill', (s) => s.split(':').pop() ?? s);
	run(SKILL_WORD_RE, 'skill', (s) => s.split('/').pop() ?? s);
	run(SLASH_RE, 'command');
	run(MCP_RE, 'mcp');
	run(TOOL_RE, 'tool');
	// Whole-word mentions of known agent/skill names (catches prose like
	// "the huashu-design skill" without explicit call syntax).
	const word = (name: string, kind: FlowRefKind) => {
		if (name.length < 4) return;
		const m = new RegExp(`\\b${escapeRe(name)}\\b`).exec(text);
		if (m) hits.push({ kind, name, idx: m.index });
	};
	for (const name of known?.skills ?? []) word(name, 'skill');
	for (const name of known?.agents ?? []) word(name, 'agent');

	hits.sort((a, b) => a.idx - b.idx);
	const seen = new Set<string>();
	const out: FlowRef[] = [];
	for (const h of hits) {
		const k = `${h.kind}:${h.name}`;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push({ kind: h.kind, name: h.name });
	}
	return out;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Derive the procedural step-sequence for one primitive body. */
export function deriveFlow(
	prim: FlowPrimitive,
	known?: { agents?: Set<string>; skills?: Set<string> }
): FlowModel {
	const lines = prim.body.split('\n');
	const source = { kind: prim.kind, name: prim.name, scope: prim.scope };

	// Pass 1 — numbered steps: lines like `1. do the thing`. Each step owns the
	// span up to the next anchor, so refs in its sub-bullets count toward it.
	const anchors: { line: number; label: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^\s{0,3}(\d{1,2})[.)]\s+(\S.*)/.exec(lines[i]);
		if (m) anchors.push({ line: i, label: m[2] });
	}
	if (anchors.length >= 2) {
		const steps: FlowStep[] = anchors.map((a, idx) => {
			const end = idx + 1 < anchors.length ? anchors[idx + 1].line : lines.length;
			const span = lines.slice(a.line, end).join('\n');
			return { n: idx + 1, label: cleanLabel(a.label), refs: extractRefs(span, known) };
		});
		return { source, steps, derivation: 'numbered', loop: LOOP_RE.test(prim.body) };
	}

	// Pass 2 — mention-order fallback: each distinct dispatch/ref, in body order,
	// becomes a step labelled by what it invokes.
	const refs = extractRefs(prim.body, known);
	const verb: Record<FlowRefKind, string> = {
		agent: 'delegates to',
		skill: 'invokes skill',
		command: 'runs command',
		mcp: 'calls MCP',
		tool: 'uses tool',
	};
	const steps: FlowStep[] = refs.map((r, idx) => ({
		n: idx + 1,
		label: `${verb[r.kind]} ${r.name}`,
		refs: [r],
	}));
	return { source, steps, derivation: 'mentions', loop: LOOP_RE.test(prim.body) };
}

/** Build the flowable-primitive list from a scan: every command / agent / skill
 *  whose body yields ≥1 step. Aggregated by `kind:name` (richest body wins, like
 *  the graph aggregates a primitive across scopes), sorted kind-then-name. */
export function buildFlowable(scan: ClaudeConfig): FlowEntry[] {
	const known = {
		agents: new Set(scan.agents.map((a) => a.name)),
		skills: new Set(scan.skills.map((s) => s.name)),
	};
	const prims: FlowPrimitive[] = [
		...scan.commands.map((c) => ({
			kind: 'command' as const,
			name: c.name,
			scope: scopeKey(c.scope, c.projectRoot),
			body: c.body,
		})),
		...scan.agents.map((a) => ({
			kind: 'agent' as const,
			name: a.name,
			scope: scopeKey(a.scope, a.projectRoot),
			body: a.body,
		})),
		...scan.skills.map((s) => ({
			kind: 'skill' as const,
			name: s.name,
			scope: scopeKey(s.scope, s.projectRoot),
			body: s.body,
		})),
	];

	const best = new Map<string, FlowEntry>();
	for (const p of prims) {
		const model = deriveFlow(p, known);
		if (model.steps.length === 0) continue;
		const key = `${p.kind}:${p.name}`;
		const prev = best.get(key);
		if (!prev || model.steps.length > prev.model.steps.length) {
			best.set(key, { key, kind: p.kind, name: p.name, scope: p.scope, model });
		}
	}

	const KIND_ORDER: FlowSourceKind[] = ['command', 'agent', 'skill'];
	return [...best.values()].sort(
		(a, b) =>
			KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name)
	);
}

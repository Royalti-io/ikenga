// deriveGraph — build the Capability graph (D-06) from a ClaudeConfig scan,
// entirely client-side. Frozen contract: see `types.ts` (gate G-EDGE).
//
// Edge derivation, by confidence:
//   DECLARATIVE (always on) — read from frontmatter / hook config:
//     • feeds : mcp → primitive   (primitive grants an `mcp__<server>__*` tool)
//     • gates : hook → primitive  (tool-matcher hook vs declared tools;
//                                   lifecycle hooks gate all agents)
//   HEURISTIC (opt-in, default on) — regex body MENTION scan (does A name B?):
//     • routes    : command → agent
//     • uses      : command|agent → skill
//     • delegates : agent → agent
//     • composes  : skill → skill
//   Heuristic edges are a cheap "A's body mentions B" test — explicitly NOT the
//   ordered step-sequence extraction the deferred Orchestration-flow view needs.

import type {
	ClaudeAgent,
	ClaudeCommand,
	ClaudeConfig,
	ClaudeFrontmatter,
	ClaudeHook,
	ClaudeSkill,
} from '@/lib/tauri-cmd';
import type { CapabilityGraph, DeriveOptions, GraphEdge, GraphNode, GraphNodeKind } from './types';

// ─── scope keys ──────────────────────────────────────────────────────────────
// Mirrors the Ngwa sidebar's scope ids (`ngwa-mode.tsx`): personal → 'personal',
// project → `project:<basename of projectRoot>`. This is a display/grouping key
// for filtering against the sidebar; it is NOT the DB-id mutation scope.
export function scopeKey(scope: 'project' | 'personal', projectRoot: string | null): string {
	if (scope === 'personal') return 'personal';
	const base = (projectRoot ?? '').split('/').filter(Boolean).pop() ?? 'project';
	return `project:${base}`;
}

// ─── frontmatter tool grants ─────────────────────────────────────────────────
/** Tools a primitive is granted, from `allowed-tools` | `allowedTools` | `tools`
 *  frontmatter (array or comma-string). Empty array when none declared. */
export function toolGrants(fm: ClaudeFrontmatter | undefined): string[] {
	if (!fm) return [];
	const raw = fm['allowed-tools'] ?? fm['allowedTools'] ?? fm['tools'];
	if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
	if (typeof raw === 'string') {
		return raw
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
	}
	return [];
}

/** MCP server name from an `mcp__<server>__<tool>` token, else null. Server
 *  segment is everything between the first and last `__` pair. */
export function mcpServerOf(tool: string): string | null {
	if (!tool.startsWith('mcp__')) return null;
	const parts = tool.split('__');
	// ['mcp', server, tool?] — server is parts[1]; require at least the server.
	return parts.length >= 2 && parts[1] ? parts[1] : null;
}

// ─── hook classification ─────────────────────────────────────────────────────
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
export function hookMatcher(h: ClaudeHook): string | null {
	const raw = h.raw as { matcher?: unknown } | null | undefined;
	const m = raw && typeof raw === 'object' ? raw.matcher : undefined;
	if (typeof m === 'string' && m.trim() && m.trim() !== '*') return m.trim();
	return null;
}
function matcherTestsTool(matcher: string, tool: string): boolean {
	try {
		return new RegExp(matcher).test(tool);
	} catch {
		// Non-regex matcher → exact / substring fallback.
		return tool === matcher || tool.includes(matcher);
	}
}

// ─── heuristic body mentions ─────────────────────────────────────────────────
const MENTION_MIN_LEN = 3;
function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Does `body` mention `name` as a whole word? Conservative: names shorter than
 *  MENTION_MIN_LEN are skipped (avoids matching "CEO" inside prose noise is
 *  still possible, hence these edges are tagged `heuristic`). */
function bodyMentions(body: string, name: string): boolean {
	if (!body || name.length < MENTION_MIN_LEN) return false;
	return new RegExp(`(^|[^\\w/-])${escapeRe(name)}([^\\w-]|$)`).test(body);
}

// ─── node assembly ───────────────────────────────────────────────────────────
interface MutableNode extends GraphNode {
	_scopes: Set<string>;
}
function ensureNode(
	map: Map<string, MutableNode>,
	kind: GraphNodeKind,
	label: string,
	scope: string,
	description: string | null
): MutableNode {
	const id = `${kind}:${label}`;
	let n = map.get(id);
	if (!n) {
		n = {
			id,
			kind,
			label,
			scopes: [],
			description: description ?? null,
			degreeOut: 0,
			degreeIn: 0,
			_scopes: new Set(),
		};
		map.set(id, n);
	}
	n._scopes.add(scope);
	if (!n.description && description) n.description = description;
	return n;
}

function hookLabel(h: ClaudeHook): string {
	const m = hookMatcher(h);
	return m ? `${h.event}:${m}` : h.event;
}

/**
 * Derive the capability graph from a scan.
 */
export function deriveGraph(scan: ClaudeConfig, opts: DeriveOptions = {}): CapabilityGraph {
	const includeHeuristic = opts.includeHeuristic ?? true;
	const scopeFilter = opts.scope && opts.scope !== 'all' ? opts.scope : null;

	const nodes = new Map<string, MutableNode>();

	// Index primitives for edge derivation (post node-build).
	const agents: { node: MutableNode; e: ClaudeAgent }[] = [];
	const commands: { node: MutableNode; e: ClaudeCommand }[] = [];
	const skills: { node: MutableNode; e: ClaudeSkill }[] = [];
	const mcpByName = new Map<string, MutableNode>();
	const hooks: { node: MutableNode; e: ClaudeHook }[] = [];

	for (const e of scan.agents) {
		const n = ensureNode(nodes, 'agent', e.name, scopeKey(e.scope, e.projectRoot), e.description);
		agents.push({ node: n, e });
	}
	for (const e of scan.commands) {
		const n = ensureNode(nodes, 'command', e.name, scopeKey(e.scope, e.projectRoot), e.description);
		commands.push({ node: n, e });
	}
	for (const e of scan.skills) {
		const n = ensureNode(nodes, 'skill', e.name, scopeKey(e.scope, e.projectRoot), e.description);
		skills.push({ node: n, e });
	}
	for (const e of scan.mcps) {
		const n = ensureNode(nodes, 'mcp', e.name, scopeKey(e.scope, e.projectRoot), null);
		mcpByName.set(e.name, n);
	}
	for (const e of scan.hooks) {
		const n = ensureNode(nodes, 'hook', hookLabel(e), scopeKey(e.scope, e.projectRoot), null);
		hooks.push({ node: n, e });
	}

	// ─── edges ──────────────────────────────────────────────────────────────
	const edges = new Map<string, GraphEdge>();
	const addEdge = (
		source: string,
		target: string,
		rel: GraphEdge['rel'],
		derivation: GraphEdge['derivation'],
		via?: string
	) => {
		if (source === target) return;
		const id = `${source}->${target}:${rel}`;
		const existing = edges.get(id);
		// Declarative wins over heuristic on the same triple.
		if (existing && existing.derivation === 'declarative') return;
		edges.set(id, { id, source, target, rel, derivation, via });
	};

	// DECLARATIVE — feeds: mcp → primitive (primitive grants mcp__<server>__*).
	const primForFeeds: { node: MutableNode; fm: ClaudeFrontmatter }[] = [
		...agents.map((a) => ({ node: a.node, fm: a.e.frontmatter })),
		...commands.map((c) => ({ node: c.node, fm: c.e.frontmatter })),
		...skills.map((s) => ({ node: s.node, fm: s.e.frontmatter })),
	];
	for (const { node, fm } of primForFeeds) {
		const servers = new Set<string>();
		for (const tool of toolGrants(fm)) {
			const srv = mcpServerOf(tool);
			if (srv) servers.add(srv);
		}
		for (const srv of servers) {
			const mcpNode = mcpByName.get(srv);
			if (mcpNode) addEdge(mcpNode.id, node.id, 'feeds', 'declarative', `tool mcp__${srv}__*`);
		}
	}

	// DECLARATIVE — gates: hook → primitive.
	const gateTargets = [
		...agents.map((a) => ({ node: a.node, tools: toolGrants(a.e.frontmatter), isAgent: true })),
		...commands.map((c) => ({ node: c.node, tools: toolGrants(c.e.frontmatter), isAgent: false })),
	];
	for (const { node: hookNode, e } of hooks) {
		const matcher = hookMatcher(e);
		if (TOOL_EVENTS.has(e.event) && matcher) {
			// tool-matcher hook → primitives that declare a matching tool.
			for (const t of gateTargets) {
				if (t.tools.some((tool) => matcherTestsTool(matcher, tool))) {
					addEdge(
						hookNode.id,
						t.node.id,
						'gates',
						'declarative',
						`${e.event} matcher "${matcher}"`
					);
				}
			}
		} else if (!TOOL_EVENTS.has(e.event)) {
			// lifecycle hook (SessionStart/Stop/PreCompact/…) → all agents.
			for (const a of agents) {
				addEdge(hookNode.id, a.node.id, 'gates', 'declarative', `${e.event} (session)`);
			}
		}
	}

	// HEURISTIC — body mention scans.
	if (includeHeuristic) {
		const agentNodes = agents.map((a) => a.node);
		const skillNodes = skills.map((s) => s.node);
		// routes: command → agent ; uses: command → skill
		for (const c of commands) {
			for (const an of agentNodes) {
				if (bodyMentions(c.e.body, an.label))
					addEdge(c.node.id, an.id, 'routes', 'heuristic', 'body mention');
			}
			for (const sn of skillNodes) {
				if (bodyMentions(c.e.body, sn.label))
					addEdge(c.node.id, sn.id, 'uses', 'heuristic', 'body mention');
			}
		}
		// uses: agent → skill ; delegates: agent → agent
		for (const a of agents) {
			for (const sn of skillNodes) {
				if (bodyMentions(a.e.body, sn.label))
					addEdge(a.node.id, sn.id, 'uses', 'heuristic', 'body mention');
			}
			for (const an of agentNodes) {
				if (an.id !== a.node.id && bodyMentions(a.e.body, an.label))
					addEdge(a.node.id, an.id, 'delegates', 'heuristic', 'body mention');
			}
		}
		// composes: skill → skill
		for (const s of skills) {
			for (const sn of skillNodes) {
				if (sn.id !== s.node.id && bodyMentions(s.e.body, sn.label))
					addEdge(s.node.id, sn.id, 'composes', 'heuristic', 'body mention');
			}
		}
	}

	// ─── finalize: scopes array, scope filter, degree counts ─────────────────
	for (const n of nodes.values()) n.scopes = [...n._scopes].sort();

	let nodeList: GraphNode[] = [...nodes.values()].map(({ _scopes, ...n }) => n);
	let edgeList = [...edges.values()];

	if (scopeFilter) {
		const keep = new Set(nodeList.filter((n) => n.scopes.includes(scopeFilter)).map((n) => n.id));
		nodeList = nodeList.filter((n) => keep.has(n.id));
		edgeList = edgeList.filter((e) => keep.has(e.source) && keep.has(e.target));
	}

	const deg = new Map<string, { out: number; in: number }>();
	for (const n of nodeList) deg.set(n.id, { out: 0, in: 0 });
	for (const e of edgeList) {
		const s = deg.get(e.source);
		const t = deg.get(e.target);
		if (s) s.out++;
		if (t) t.in++;
	}
	for (const n of nodeList) {
		const d = deg.get(n.id);
		n.degreeOut = d?.out ?? 0;
		n.degreeIn = d?.in ?? 0;
	}

	return { nodes: nodeList, edges: edgeList };
}

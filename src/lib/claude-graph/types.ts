// Capability-graph model — the typed node/edge contract for the Ngwa Analyze
// "Capability graph" surface (Phase 4, D-06). Frozen as gate G-EDGE: both graph
// renderers (Radial bundle, Swimlane flow) and any future Analyze consumer
// program against THIS shape, never against the raw scan payload.
//
// The model is derived entirely CLIENT-SIDE from the existing `ClaudeConfig`
// scan (`claudeConfigLoad`) — no Rust change. See `derive.ts` for the rules.

/** The five primitive kinds the graph renders, matching the scanner + the
 *  locked mockups' colour/glyph palette. Built-in tools (Bash, Read, …) are an
 *  *attribute* of an edge's matcher, not a node kind, in v1. */
export type GraphNodeKind = 'command' | 'agent' | 'skill' | 'mcp' | 'hook';

/** Relationship kinds on a directed edge. Split by how confidently they're
 *  derived (see `GraphEdge.derivation`):
 *   - `feeds`  — an MCP server provides tools to a primitive (declarative).
 *   - `gates`  — a hook intercepts a primitive's lifecycle/tool use (declarative).
 *   - `uses`   — a primitive invokes a skill (heuristic body mention).
 *   - `routes` — a command hands off to an agent (heuristic body mention).
 *   - `delegates` — an agent spawns another agent via Task() (heuristic).
 *   - `composes`  — a skill composes another skill (heuristic body mention). */
export type GraphEdgeKind = 'feeds' | 'gates' | 'uses' | 'routes' | 'delegates' | 'composes';

/** How an edge was derived, so the UI can visually distinguish certainty.
 *   - `declarative` — read straight from frontmatter / hook config / manifest.
 *     High confidence; always shown solid.
 *   - `heuristic`   — a regex body MENTION scan (does A's body name B?). Cheap,
 *     medium confidence; the UI may dash/badge these. NOT the ordered
 *     step-sequence extraction the deferred Orchestration-flow view needs. */
export type EdgeDerivation = 'declarative' | 'heuristic';

/** A graph node = one logical primitive, aggregated across every scope it
 *  appears in (e.g. `groundwork` present in personal + project:ikenga is ONE
 *  node with `scopes: ['personal','project:ikenga']`). */
export interface GraphNode {
	/** Stable id: `${kind}:${name}`. Same name+kind across scopes = one node. */
	id: string;
	kind: GraphNodeKind;
	/** Display name (primitive name, or hook event label). */
	label: string;
	/** Every scope key this primitive appears in, e.g. `personal`,
	 *  `project:<id>`. Aggregated; never empty. */
	scopes: string[];
	/** First non-null description encountered across scopes, or null. */
	description: string | null;
	/** Out-degree / in-degree, filled by `deriveGraph` after edge assembly. */
	degreeOut: number;
	degreeIn: number;
}

/** A directed relationship between two nodes. */
export interface GraphEdge {
	/** Stable id: `${source}->${target}:${rel}`. Deduped on this key. */
	id: string;
	/** Source node id. */
	source: string;
	/** Target node id. */
	target: string;
	rel: GraphEdgeKind;
	derivation: EdgeDerivation;
	/** Optional one-line provenance, e.g. `allowed-tools: mcp__royalti-mcp__*`
	 *  or `PreToolUse matcher "Bash"`. Surfaced in the detail card. */
	via?: string;
}

/** The complete derived graph handed to a renderer. */
export interface CapabilityGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/** Options controlling derivation breadth. */
export interface DeriveOptions {
	/** Include `heuristic` (body-mention) edges. Default `true`. When `false`
	 *  only `declarative` edges (feeds/gates) are produced — the strict view. */
	includeHeuristic?: boolean;
	/** Restrict to a single scope key (`personal` | `project:<id>`). When set,
	 *  only nodes appearing in that scope (and edges between them) are kept.
	 *  `undefined` / `'all'` = every scope. */
	scope?: string;
}

/** Canonical kind ordering — used by renderers for arc/column placement and by
 *  the kind-filter legend. */
export const GRAPH_KIND_ORDER: readonly GraphNodeKind[] = [
	'command',
	'agent',
	'skill',
	'mcp',
	'hook',
] as const;

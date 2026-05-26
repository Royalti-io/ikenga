// Shared constants + types for the capability-graph renderers (Bundle, Force,
// Swimlane, Layered-DAG). All four consume the same filtered CapabilityGraph
// `view` and the same RendererProps.

import type { CapabilityGraph, GraphEdge, GraphNodeKind } from '@/lib/claude-graph';

export const KIND_GLYPH: Record<GraphNodeKind, string> = {
	command: '⌘',
	agent: '★',
	skill: '◆',
	mcp: '⬡',
	hook: '⚡',
};
export const KIND_LABEL: Record<GraphNodeKind, string> = {
	command: 'Commands',
	agent: 'Agents',
	skill: 'Skills',
	mcp: 'MCPs',
	hook: 'Hooks',
};
export const REL_COLOR: Record<GraphEdge['rel'], string> = {
	routes: 'var(--nk-command)',
	uses: 'var(--tint-fg-active, var(--primary))',
	delegates: 'var(--nk-agent)',
	composes: 'var(--nk-skill)',
	feeds: 'var(--nk-mcp)',
	gates: 'var(--nk-hook)',
};
/** Selected-node outgoing-edge colour (ngwa amber). */
export const NGWA = 'var(--tint-fg-active, var(--primary))';
/** Selected-node incoming-edge colour (verdigris). */
export const VERDIGRIS = 'var(--systemic)';

/** Relations rendered dashed (the "modifier/input" edges). */
export const DASHED_RELS: ReadonlySet<GraphEdge['rel']> = new Set<GraphEdge['rel']>([
	'feeds',
	'gates',
	'delegates',
	'composes',
]);

export interface RendererProps {
	graph: CapabilityGraph;
	selected: string | null;
	incident: { nodes: Set<string>; edges: Set<string> } | null;
	onSelect: (id: string) => void;
	/** Flipped true during a pan-drag so the parent suppresses the
	 *  background-click deselect. */
	draggedRef?: React.MutableRefObject<boolean>;
}

export function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

export function edgeColor(e: GraphEdge, selected: string | null): string {
	if (selected) {
		if (e.source === selected) return NGWA;
		if (e.target === selected) return VERDIGRIS;
	}
	return REL_COLOR[e.rel];
}

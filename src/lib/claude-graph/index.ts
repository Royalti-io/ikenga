// Capability-graph derivation (Phase 4 · D-06 · gate G-EDGE). Client-side model
// for the Ngwa Analyze "Capability graph" surface, derived from the existing
// `claudeConfigLoad` scan — no Rust change.
export type {
	CapabilityGraph,
	DeriveOptions,
	EdgeDerivation,
	GraphEdge,
	GraphEdgeKind,
	GraphNode,
	GraphNodeKind,
} from './types';
export { GRAPH_KIND_ORDER } from './types';
export { deriveGraph, mcpServerOf, toolGrants } from './derive';

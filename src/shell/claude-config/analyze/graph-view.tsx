// Capability graph (Phase 4 · D-06) — the Ngwa Analyze "Capability graph"
// surface. FOUR layout modes over ONE derived model (`deriveGraph`, gate
// G-EDGE), each in its own renderer:
//   • Bundle   — d3 radial edge-bundling; density-first (BundleRenderer here).
//   • Force    — d3-force constellation; clusters emerge (./graph-force).
//   • Flow     — kind-banded columns; legibility-first (SwimlaneRenderer here).
//   • Layered  — dagre auto-ranked DAG; routed edges (./graph-dag).
// Filters (search · kind · hide-leaves · ego-isolate · scope) narrow the shared
// `view` upstream, so all renderers get the filtered graph. Selecting a node
// isolates its neighbourhood (out = ngwa amber, in = verdigris) + opens the
// detail card. Derived entirely client-side from the scan — see @/lib/claude-graph.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cluster, hierarchy, type HierarchyNode } from 'd3-hierarchy';
import { curveBundle, lineRadial } from 'd3-shape';

import { cn } from '@/components/ui/utils';
import type { ClaudeConfig } from '@/lib/tauri-cmd';
import {
	type CapabilityGraph,
	deriveGraph,
	GRAPH_KIND_ORDER,
	type GraphEdge,
	type GraphNode,
	type GraphNodeKind,
} from '@/lib/claude-graph';
import { GraphDag } from './graph-dag';
import { GraphForce } from './graph-force';
import { clamp, edgeColor, KIND_GLYPH, KIND_LABEL, NGWA, type RendererProps } from './graph-shared';

type GraphMode = 'bundle' | 'force' | 'swimlane' | 'dag';

function scopeLabel(key: string): string {
	if (key === 'all') return 'All scopes';
	if (key === 'personal') return 'Personal';
	return key.startsWith('project:') ? key.slice(8) : key;
}

interface GraphViewProps {
	config: ClaudeConfig | null;
	/** Sidebar scope: 'all' | 'personal' | `project:<basename>`. */
	scope: string;
}

export function GraphView({ config, scope }: GraphViewProps) {
	const [mode, setMode] = useState<GraphMode>('bundle');
	const [selected, setSelected] = useState<string | null>(null);
	const [hidden, setHidden] = useState<Set<GraphNodeKind>>(() => new Set());
	const [includeHeuristic, setIncludeHeuristic] = useState(true);
	const [query, setQuery] = useState('');
	const [hideLeaves, setHideLeaves] = useState(false);
	const [egoIsolate, setEgoIsolate] = useState(false);
	// In-view scope filter (mirrors the store map's). Seeded from the sidebar
	// scope and kept in sync with it, but also settable here.
	const [scopeSel, setScopeSel] = useState(scope);
	useEffect(() => setScopeSel(scope), [scope]);
	// Set true while a pan-drag is in flight so the trailing click on the stage
	// background doesn't clear the selection.
	const draggedRef = useRef(false);

	// Derive the whole graph once (all scopes); the scope filter narrows it.
	const fullGraph = useMemo<CapabilityGraph>(() => {
		if (!config) return { nodes: [], edges: [] };
		return deriveGraph(config, { includeHeuristic });
	}, [config, includeHeuristic]);

	// Scope options come from the unfiltered node set ('all' + each scope present).
	const scopeOptions = useMemo(() => {
		const s = new Set<string>();
		for (const n of fullGraph.nodes) for (const sc of n.scopes) s.add(sc);
		return [...s].sort((a, b) => {
			if (a === 'personal') return -1;
			if (b === 'personal') return 1;
			return a.localeCompare(b);
		});
	}, [fullGraph]);

	const graph = useMemo<CapabilityGraph>(() => {
		if (scopeSel === 'all') return fullGraph;
		const keep = new Set(
			fullGraph.nodes.filter((n) => n.scopes.includes(scopeSel)).map((n) => n.id)
		);
		return {
			nodes: fullGraph.nodes.filter((n) => keep.has(n.id)),
			edges: fullGraph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
		};
	}, [fullGraph, scopeSel]);

	// Base subgraph: kind filter + search + hide-leaves. Independent of the
	// current selection so clicking a node doesn't trigger a relayout.
	const base = useMemo<CapabilityGraph>(() => {
		const q = query.trim().toLowerCase();
		let nodes = graph.nodes;
		if (hidden.size) nodes = nodes.filter((n) => !hidden.has(n.kind));
		if (q) nodes = nodes.filter((n) => n.label.toLowerCase().includes(q));
		let keep = new Set(nodes.map((n) => n.id));
		let edges = graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
		if (hideLeaves) {
			const deg = new Map<string, number>();
			for (const e of edges) {
				deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
				deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
			}
			nodes = nodes.filter((n) => (deg.get(n.id) ?? 0) > 0);
			keep = new Set(nodes.map((n) => n.id));
			edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
		}
		return { nodes, edges };
	}, [graph, hidden, query, hideLeaves]);

	// Ego isolate: when a node is selected and isolate is on, restrict to its
	// closed neighbourhood. Returns `base` unchanged otherwise (stable identity).
	const view = useMemo<CapabilityGraph>(() => {
		if (!egoIsolate || !selected) return base;
		const nb = new Set<string>([selected]);
		for (const e of base.edges) {
			if (e.source === selected) nb.add(e.target);
			if (e.target === selected) nb.add(e.source);
		}
		return {
			nodes: base.nodes.filter((n) => nb.has(n.id)),
			edges: base.edges.filter((e) => nb.has(e.source) && nb.has(e.target)),
		};
	}, [base, egoIsolate, selected]);

	const nodeById = useMemo(() => {
		const m = new Map<string, GraphNode>();
		for (const n of view.nodes) m.set(n.id, n);
		return m;
	}, [view]);

	// Incident sets for the selected node.
	const incident = useMemo(() => {
		if (!selected) return null;
		const nodes = new Set<string>([selected]);
		const edges = new Set<string>();
		for (const e of view.edges) {
			if (e.source === selected || e.target === selected) {
				edges.add(e.id);
				nodes.add(e.source);
				nodes.add(e.target);
			}
		}
		return { nodes, edges };
	}, [selected, view]);

	const selNode = selected ? nodeById.get(selected) : null;
	const presentKinds = useMemo(() => {
		const s = new Set<GraphNodeKind>();
		for (const n of graph.nodes) s.add(n.kind);
		return s;
	}, [graph]);

	function toggleKind(k: GraphNodeKind) {
		setHidden((prev) => {
			const next = new Set(prev);
			if (next.has(k)) next.delete(k);
			else next.add(k);
			return next;
		});
	}

	if (!config) {
		return <div className="ngwa-analyze-empty">Loading configuration…</div>;
	}
	if (graph.nodes.length === 0) {
		return (
			<div className="ngwa-analyze-empty">
				No primitives in this scope yet. Add agents, skills, commands, hooks, or MCP servers to see
				the capability graph.
			</div>
		);
	}

	return (
		<div className="ngwa-graph">
			<div className="ngwa-graph-toolbar">
				<div className="ngwa-seg" role="group" aria-label="Graph layout">
					<button
						type="button"
						className={cn(mode === 'bundle' && 'on')}
						onClick={() => setMode('bundle')}
						title="Radial edge-bundling — density-first"
					>
						◐ Bundle
					</button>
					<button
						type="button"
						className={cn(mode === 'force' && 'on')}
						onClick={() => setMode('force')}
						title="Force-directed constellation — clusters emerge; drag to reposition"
					>
						◍ Force
					</button>
					<button
						type="button"
						className={cn(mode === 'swimlane' && 'on')}
						onClick={() => setMode('swimlane')}
						title="Kind-banded columns — flow-first"
					>
						▤ Flow
					</button>
					<button
						type="button"
						className={cn(mode === 'dag' && 'on')}
						onClick={() => setMode('dag')}
						title="Layered DAG — auto-ranked by dependency depth, routed edges"
					>
						⇉ Layered
					</button>
				</div>
				<div className="ngwa-graph-meta">
					{view.nodes.length} nodes · {view.edges.length} links
				</div>
				<input
					className="ngwa-graph-search"
					placeholder="filter nodes…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<select
					className="ngwa-graph-select"
					value={scopeSel}
					onChange={(e) => setScopeSel(e.target.value)}
					title="Narrow to one scope / project"
				>
					<option value="all">All scopes</option>
					{scopeOptions.map((s) => (
						<option key={s} value={s}>
							{scopeLabel(s)}
						</option>
					))}
				</select>
				{selected && (
					<button
						type="button"
						className={cn('ngwa-graph-pillbtn', egoIsolate && 'on')}
						onClick={() => setEgoIsolate((v) => !v)}
						title="Isolate the selected node + its neighbourhood"
					>
						⊙ isolate
					</button>
				)}
				<button
					type="button"
					className={cn('ngwa-graph-pillbtn', hideLeaves && 'on')}
					onClick={() => setHideLeaves((v) => !v)}
					title="Hide unconnected nodes (no links in the current view)"
				>
					⤫ hide leaves
				</button>
				<div className="ngwa-graph-spacer" />
				<div className="ngwa-kind-filter">
					{GRAPH_KIND_ORDER.filter((k) => presentKinds.has(k)).map((k) => (
						<button
							type="button"
							key={k}
							className={cn('ngwa-kf', hidden.has(k) && 'off')}
							onClick={() => toggleKind(k)}
							title={`Toggle ${KIND_LABEL[k]}`}
						>
							<span className="kd" style={{ background: `var(--nk-${k})` }} />
							{k}
						</button>
					))}
				</div>
				<button
					type="button"
					className={cn('ngwa-heur', !includeHeuristic && 'off')}
					onClick={() => setIncludeHeuristic((v) => !v)}
					title="Heuristic edges are inferred from body mentions (dashed). Toggle off for declarative-only."
				>
					{includeHeuristic ? '◆ inferred on' : '◇ declarative only'}
				</button>
			</div>

			<div
				className="ngwa-graph-stage"
				onClick={() => {
					if (draggedRef.current) {
						draggedRef.current = false;
						return;
					}
					setSelected(null);
				}}
			>
				{view.nodes.length === 0 ? (
					<div className="ngwa-graph-nomatch">No nodes match the current filters.</div>
				) : mode === 'bundle' ? (
					<BundleRenderer
						graph={view}
						selected={selected}
						incident={incident}
						onSelect={setSelected}
						draggedRef={draggedRef}
					/>
				) : mode === 'force' ? (
					<GraphForce
						graph={view}
						selected={selected}
						incident={incident}
						onSelect={setSelected}
						draggedRef={draggedRef}
					/>
				) : mode === 'dag' ? (
					<GraphDag
						graph={view}
						selected={selected}
						incident={incident}
						onSelect={setSelected}
						draggedRef={draggedRef}
					/>
				) : (
					<SwimlaneRenderer
						graph={view}
						selected={selected}
						incident={incident}
						onSelect={setSelected}
					/>
				)}
				{selNode && view.nodes.length > 0 && (
					<GraphDetailCard node={selNode} graph={view} nodeById={nodeById} />
				)}
			</div>
		</div>
	);
}

// ─── Radial bundle ───────────────────────────────────────────────────────────
type BundleDatum = {
	name: string;
	kind?: GraphNodeKind;
	node?: GraphNode;
	children?: BundleDatum[];
};

const BUNDLE_LABEL_ZOOM = 1.5; // show all labels at/above this zoom
const BUNDLE_HUB_DEGREE = 6; // hubs at/above this degree stay labelled when zoomed out

function BundleRenderer({ graph, selected, incident, onSelect, draggedRef }: RendererProps) {
	const SIZE = 820;
	const R = SIZE / 2 - 132;
	const svgRef = useRef<SVGSVGElement>(null);
	const [t, setT] = useState({ k: 1, x: 0, y: 0 });
	const dragRef = useRef<{ x: number; y: number; moved: boolean; pid: number } | null>(null);
	const [hover, setHover] = useState<string | null>(null);

	// Reset the view when the graph identity changes (mode/scope/filter swap).
	useEffect(() => {
		setT({ k: 1, x: 0, y: 0 });
	}, [graph]);

	// Map a pointer event to SVG viewBox coords (independent of our pan/zoom <g>).
	function toVB(clientX: number, clientY: number): { x: number; y: number } {
		const svg = svgRef.current;
		const ctm = svg?.getScreenCTM();
		if (!svg || !ctm) return { x: 0, y: 0 };
		const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
		return { x: p.x, y: p.y };
	}
	function zoomAbout(cx: number, cy: number, factor: number) {
		setT((v) => {
			const k = clamp(v.k * factor, 0.4, 8);
			const ratio = k / v.k;
			return { k, x: cx - ratio * (cx - v.x), y: cy - ratio * (cy - v.y) };
		});
	}
	// Non-passive wheel listener so we can preventDefault the page scroll.
	useEffect(() => {
		const svg = svgRef.current;
		if (!svg) return;
		const onWheel = (ev: WheelEvent) => {
			ev.preventDefault();
			const c = toVB(ev.clientX, ev.clientY);
			zoomAbout(c.x, c.y, ev.deltaY < 0 ? 1.15 : 1 / 1.15);
		};
		svg.addEventListener('wheel', onWheel, { passive: false });
		return () => svg.removeEventListener('wheel', onWheel);
	}, []);

	// Pan starts only once the pointer moves past a small threshold — until then
	// it's a potential click, so we DON'T capture the pointer (capturing on
	// pointerdown would steal the click from node <g> elements). A plain click
	// thus falls through to the node's onClick; a drag captures + pans.
	const DRAG_THRESHOLD = 4; // viewBox units (~3px)
	function onPointerDown(ev: React.PointerEvent<SVGSVGElement>) {
		if (ev.button !== 0) return;
		const p = toVB(ev.clientX, ev.clientY);
		dragRef.current = { x: p.x, y: p.y, moved: false, pid: ev.pointerId };
	}
	function onPointerMove(ev: React.PointerEvent<SVGSVGElement>) {
		const d = dragRef.current;
		if (!d) return;
		const p = toVB(ev.clientX, ev.clientY);
		const dx = p.x - d.x;
		const dy = p.y - d.y;
		if (!d.moved) {
			if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return; // still a click
			d.moved = true;
			if (draggedRef) draggedRef.current = true;
			try {
				ev.currentTarget.setPointerCapture(d.pid);
			} catch {}
		}
		setT((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
		d.x = p.x;
		d.y = p.y;
	}
	function onPointerUp(ev: React.PointerEvent<SVGSVGElement>) {
		const d = dragRef.current;
		dragRef.current = null;
		if (d?.moved) {
			try {
				ev.currentTarget.releasePointerCapture?.(d.pid);
			} catch {}
		}
	}

	const layout = useMemo(() => {
		const groups: BundleDatum[] = GRAPH_KIND_ORDER.map((k) => ({
			name: k,
			kind: k,
			children: graph.nodes
				.filter((n) => n.kind === k)
				.map((n) => ({ name: n.id, kind: k, node: n })),
		})).filter((g) => g.children && g.children.length > 0);

		const root = hierarchy<BundleDatum>({ name: 'root', children: groups }).sort((a, b) =>
			(a.data.node?.label ?? a.data.name).localeCompare(b.data.node?.label ?? b.data.name)
		);
		cluster<BundleDatum>().size([360, R])(root);
		const leaves = root.leaves();
		const leafById = new Map<string, HierarchyNode<BundleDatum>>();
		for (const l of leaves) if (l.data.node) leafById.set(l.data.node.id, l);

		const line = lineRadial<HierarchyNode<BundleDatum>>()
			.curve(curveBundle.beta(0.78))
			.radius((d) => d.y ?? 0)
			.angle((d) => ((d.x ?? 0) * Math.PI) / 180);

		const links = graph.edges
			.map((e) => {
				const s = leafById.get(e.source);
				const t = leafById.get(e.target);
				if (!s || !t) return null;
				return { edge: e, d: line(s.path(t)) ?? '' };
			})
			.filter((x): x is { edge: GraphEdge; d: string } => x !== null);

		// Group arcs (kind bands) — start/end angle per kind.
		const arcs = (root.children ?? []).map((g) => {
			const xs = (g.children ?? []).map((c) => c.x ?? 0);
			return { kind: g.data.kind as GraphNodeKind, a0: Math.min(...xs), a1: Math.max(...xs) };
		});

		return { leaves, links, arcs };
	}, [graph, R]);

	const dimNode = (id: string) => incident !== null && !incident.nodes.has(id);
	const dimEdge = (e: GraphEdge) => incident !== null && !incident.edges.has(e.id);
	// Label declutter: at this density, show a label only when the view is
	// zoomed in, the node is a hub, or it's hovered / in the selected
	// neighbourhood. Keeps the overview readable; zoom reveals the rest.
	const showLabel = (n: GraphNode): boolean =>
		t.k >= BUNDLE_LABEL_ZOOM ||
		hover === n.id ||
		selected === n.id ||
		incident?.nodes.has(n.id) === true ||
		n.degreeOut + n.degreeIn >= BUNDLE_HUB_DEGREE;

	return (
		<>
			<svg
				ref={svgRef}
				className="ngwa-graph-svg"
				viewBox={`0 0 ${SIZE} ${SIZE}`}
				preserveAspectRatio="xMidYMid meet"
				style={{ cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerUp}
			>
				<g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
					<g transform={`translate(${SIZE / 2},${SIZE / 2})`}>
						{/* kind arcs + labels */}
						{layout.arcs.map((arc) => {
							const mid = (arc.a0 + arc.a1) / 2;
							const rad = ((mid - 90) * Math.PI) / 180;
							const lr = R + 30;
							return (
								<text
									key={arc.kind}
									x={Math.cos(rad) * lr}
									y={Math.sin(rad) * lr}
									textAnchor="middle"
									dominantBaseline="middle"
									className="ngwa-arc-label"
									fill={`var(--nk-${arc.kind})`}
								>
									{KIND_LABEL[arc.kind].toUpperCase()}
								</text>
							);
						})}
						{/* links */}
						<g fill="none">
							{layout.links.map(({ edge, d }) => (
								<path
									key={edge.id}
									d={d}
									stroke={edgeColor(edge, selected)}
									strokeWidth={incident?.edges.has(edge.id) ? 2 : 1.1}
									strokeOpacity={dimEdge(edge) ? 0.05 : selected ? 0.85 : 0.24}
									strokeDasharray={edge.derivation === 'heuristic' ? '4,4' : undefined}
								/>
							))}
						</g>
						{/* nodes */}
						{layout.leaves.map((leaf) => {
							const n = leaf.data.node;
							if (!n) return null;
							const angle = leaf.x ?? 0;
							const flip = angle >= 180;
							const r = 4 + Math.min(5, (n.degreeOut + n.degreeIn) * 0.6);
							const isSel = selected === n.id;
							return (
								<g
									key={n.id}
									transform={`rotate(${angle - 90}) translate(${leaf.y ?? 0},0)`}
									className="ngwa-gnode"
									opacity={dimNode(n.id) ? 0.18 : 1}
									onMouseEnter={() => setHover(n.id)}
									onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
									onClick={(ev) => {
										ev.stopPropagation();
										onSelect(n.id);
									}}
								>
									<circle
										r={r}
										fill={`color-mix(in srgb, var(--nk-${n.kind}) 24%, var(--bg-raised))`}
										stroke={isSel ? NGWA : `var(--nk-${n.kind})`}
										strokeWidth={isSel ? 2.5 : 1.5}
									/>
									{showLabel(n) && (
										<text
											className="ngwa-gnode-label"
											dy="0.31em"
											x={flip ? -(r + 5) : r + 5}
											textAnchor={flip ? 'end' : 'start'}
											transform={flip ? 'rotate(180)' : undefined}
											fill={isSel ? 'var(--fg)' : 'var(--fg-muted)'}
											fontWeight={isSel ? 600 : 400}
										>
											{n.label}
										</text>
									)}
								</g>
							);
						})}
					</g>
				</g>
			</svg>
			<div className="ngwa-zoom">
				<button type="button" title="Zoom in" onClick={() => zoomAbout(SIZE / 2, SIZE / 2, 1.3)}>
					+
				</button>
				<button
					type="button"
					title="Zoom out"
					onClick={() => zoomAbout(SIZE / 2, SIZE / 2, 1 / 1.3)}
				>
					−
				</button>
				<button
					type="button"
					title="Reset view"
					style={{ fontSize: 12 }}
					onClick={() => setT({ k: 1, x: 0, y: 0 })}
				>
					⊡
				</button>
			</div>
		</>
	);
}

// ─── Swimlane flow ───────────────────────────────────────────────────────────
const COLS: { id: string; title: string; kinds: GraphNodeKind[] }[] = [
	{ id: 'inputs', title: 'Triggers & inputs', kinds: ['command', 'mcp', 'hook'] },
	{ id: 'agents', title: 'Agents', kinds: ['agent'] },
	{ id: 'skills', title: 'Skills', kinds: ['skill'] },
];

function SwimlaneRenderer({ graph, selected, incident, onSelect }: RendererProps) {
	const stageRef = useRef<HTMLDivElement>(null);
	const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	const [paths, setPaths] = useState<{ edge: GraphEdge; d: string }[]>([]);

	const colNodes = useMemo(() => {
		return COLS.map((c) => ({
			...c,
			groups: c.kinds
				.map((k) => ({ kind: k, nodes: graph.nodes.filter((n) => n.kind === k) }))
				.filter((g) => g.nodes.length > 0),
		}));
	}, [graph]);

	// Measure card centres → draw edges. Re-run on layout/size change.
	useLayoutEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		function measure() {
			const box = stage!.getBoundingClientRect();
			const colIndex = new Map<string, number>();
			COLS.forEach((c, i) => {
				for (const k of c.kinds) colIndex.set(k, i);
			});
			const next: { edge: GraphEdge; d: string }[] = [];
			for (const e of graph.edges) {
				const se = cardRefs.current.get(e.source);
				const te = cardRefs.current.get(e.target);
				if (!se || !te) continue;
				const sr = se.getBoundingClientRect();
				const tr = te.getBoundingClientRect();
				const sNode = graph.nodes.find((n) => n.id === e.source);
				const tNode = graph.nodes.find((n) => n.id === e.target);
				const si = sNode ? (colIndex.get(sNode.kind) ?? 0) : 0;
				const ti = tNode ? (colIndex.get(tNode.kind) ?? 0) : 0;
				let x1: number;
				let x2: number;
				const y1 = sr.top + sr.height / 2 - box.top;
				const y2 = tr.top + tr.height / 2 - box.top;
				if (si < ti) {
					x1 = sr.right - box.left;
					x2 = tr.left - box.left;
				} else if (si > ti) {
					x1 = sr.left - box.left;
					x2 = tr.right - box.left;
				} else {
					x1 = sr.right - box.left;
					x2 = tr.right - box.left;
				}
				const d =
					si === ti
						? `M${x1},${y1} C${x1 + 46},${y1} ${x2 + 46},${y2} ${x2},${y2}`
						: `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
				next.push({ edge: e, d });
			}
			setPaths(next);
		}
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(stage);
		return () => ro.disconnect();
	}, [graph]);

	const dimNode = (id: string) => incident !== null && !incident.nodes.has(id);
	const dimEdge = (e: GraphEdge) => incident !== null && !incident.edges.has(e.id);

	return (
		<div className="ngwa-swim" ref={stageRef}>
			<svg className="ngwa-swim-edges">
				{paths.map(({ edge, d }) => (
					<path
						key={edge.id}
						d={d}
						fill="none"
						stroke={edgeColor(edge, selected)}
						strokeWidth={incident?.edges.has(edge.id) ? 2 : 1.3}
						strokeOpacity={dimEdge(edge) ? 0.05 : selected ? 0.9 : 0.32}
						strokeDasharray={edge.derivation === 'heuristic' ? '5,4' : undefined}
					/>
				))}
			</svg>
			<div className="ngwa-swim-cols">
				{colNodes.map((col) => (
					<div className="ngwa-swim-col" key={col.id}>
						<div className="ngwa-swim-colh">{col.title}</div>
						{col.groups.map((g) => (
							<div className="ngwa-swim-group" key={g.kind}>
								{COLS[0].kinds.length > 1 && col.id === 'inputs' && (
									<div className="ngwa-swim-subh">
										<span className="kd" style={{ background: `var(--nk-${g.kind})` }} />
										{KIND_LABEL[g.kind]}
									</div>
								)}
								<div className="ngwa-swim-stack">
									{g.nodes.map((n) => (
										<GraphCard
											key={n.id}
											node={n}
											selected={selected === n.id}
											dimmed={dimNode(n.id)}
											onSelect={onSelect}
											cardRef={(el) => {
												if (el) cardRefs.current.set(n.id, el);
												else cardRefs.current.delete(n.id);
											}}
										/>
									))}
								</div>
							</div>
						))}
					</div>
				))}
			</div>
		</div>
	);
}

function GraphCard({
	node,
	selected,
	dimmed,
	onSelect,
	cardRef,
}: {
	node: GraphNode;
	selected: boolean;
	dimmed: boolean;
	onSelect: (id: string) => void;
	cardRef: (el: HTMLDivElement | null) => void;
}) {
	return (
		<div
			ref={cardRef}
			className={cn('ngwa-gcard', selected && 'sel', dimmed && 'dim')}
			style={{ ['--accent' as string]: `var(--nk-${node.kind})` }}
			onClick={(ev) => {
				ev.stopPropagation();
				onSelect(node.id);
			}}
		>
			<span className="ngwa-gcard-ic">{KIND_GLYPH[node.kind]}</span>
			<span className="ngwa-gcard-tx">
				<span className="ngwa-gcard-nm">{node.label}</span>
				<span className="ngwa-gcard-sc">{node.scopes.join(' · ')}</span>
			</span>
			<span className="ngwa-gcard-deg" title={`${node.degreeOut + node.degreeIn} connections`}>
				{node.degreeOut + node.degreeIn}
			</span>
		</div>
	);
}

// ─── Detail card ─────────────────────────────────────────────────────────────
function GraphDetailCard({
	node,
	graph,
	nodeById,
}: {
	node: GraphNode;
	graph: CapabilityGraph;
	nodeById: Map<string, GraphNode>;
}) {
	const out = graph.edges.filter((e) => e.source === node.id);
	const inc = graph.edges.filter((e) => e.target === node.id);
	return (
		<div className="ngwa-graph-detail">
			<span className="ngwa-gd-kind" style={{ ['--accent' as string]: `var(--nk-${node.kind})` }}>
				<span className="dd" />
				{node.kind}
			</span>
			<div className="ngwa-gd-name">{node.label}</div>
			<div className="ngwa-gd-scope">{node.scopes.join(' · ')}</div>
			{node.description && <div className="ngwa-gd-desc">{node.description}</div>}
			<div className="ngwa-gd-ch">
				<span>Connections</span>
				<span>{out.length + inc.length}</span>
			</div>
			{out.map((e) => (
				<div className="ngwa-gd-conn" key={e.id}>
					<span className="ar out">→</span>
					<span className="tg">{nodeById.get(e.target)?.label ?? e.target}</span>
					<span className="rl">
						{e.rel}
						{e.derivation === 'heuristic' ? '*' : ''}
					</span>
				</div>
			))}
			{inc.map((e) => (
				<div className="ngwa-gd-conn" key={e.id}>
					<span className="ar in">←</span>
					<span className="tg">{nodeById.get(e.source)?.label ?? e.source}</span>
					<span className="rl">
						{e.rel}
						{e.derivation === 'heuristic' ? '*' : ''}
					</span>
				</div>
			))}
		</div>
	);
}

// Capability graph · Force constellation (Phase 4 · D-06 mode). d3-force
// physics layout: nodes repel, edges spring, clusters emerge. Drag to
// reposition, wheel/drag to pan-zoom, labels declutter by zoom/hub/selection.
// Consumes the shared filtered `view` + RendererProps; selection is controlled
// by the parent (GraphView owns the detail card).

import { useEffect, useRef } from 'react';
import { drag as d3drag } from 'd3-drag';
import {
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from 'd3-force';
import { select, type Selection } from 'd3-selection';
import { zoom as d3zoom, type ZoomBehavior } from 'd3-zoom';
import type { GraphEdge, GraphNode } from '@/lib/claude-graph';
import { DASHED_RELS, NGWA, REL_COLOR, type RendererProps, VERDIGRIS } from './graph-shared';

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & {
	rel: GraphEdge['rel'];
	derivation: GraphEdge['derivation'];
};

const LABEL_ZOOM = 1.4;
const HUB_DEGREE = 8;

export function GraphForce({ graph, selected, incident, onSelect, draggedRef }: RendererProps) {
	const svgRef = useRef<SVGSVGElement>(null);
	// Imperative d3 handles, rebuilt when the graph changes.
	// biome-ignore lint/suspicious/noExplicitAny: d3 selection generics are noise here
	type AnySel = Selection<any, any, any, any>;
	const api = useRef<{
		node: AnySel;
		link: AnySel;
		sim: Simulation<SimNode, SimLink>;
		k: number;
		refresh: () => void;
	} | null>(null);
	// Keep latest selection in a ref so the (graph-keyed) build effect's
	// handlers read current values without rebinding.
	const selRef = useRef<{ selected: string | null; incident: RendererProps['incident'] }>({
		selected,
		incident,
	});
	selRef.current = { selected, incident };

	// biome-ignore lint/correctness/useExhaustiveDependencies: rebuild only on graph identity
	useEffect(() => {
		const el = svgRef.current;
		if (!el) return;
		const W = el.clientWidth || 800;
		const H = el.clientHeight || 600;
		const svg = select(el);
		svg.selectAll('*').remove();
		const root = svg.append('g');

		const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
		const links: SimLink[] = graph.edges.map((e) => ({
			source: e.source,
			target: e.target,
			rel: e.rel,
			derivation: e.derivation,
		}));

		const gLink = root.append('g').attr('fill', 'none');
		const gNode = root.append('g');

		const link = gLink
			.selectAll('path')
			.data(links)
			.join('path')
			.attr('stroke', (d) => REL_COLOR[d.rel])
			.attr('stroke-width', 1)
			.attr('stroke-opacity', 0.22)
			.attr('stroke-dasharray', (d) => (DASHED_RELS.has(d.rel) ? '4,4' : null));

		const node = gNode
			.selectAll<SVGGElement, SimNode>('g')
			.data(nodes)
			.join('g')
			.style('cursor', 'pointer')
			.on('click', (ev: MouseEvent, d) => {
				ev.stopPropagation();
				onSelect(d.id);
			});
		node
			.append('circle')
			.attr('r', (d) => 5 + Math.min(8, (d.degreeOut + d.degreeIn) * 0.8))
			.attr('fill', (d) => `color-mix(in srgb, var(--nk-${d.kind}) 26%, var(--bg-raised))`)
			.attr('stroke', (d) => `var(--nk-${d.kind})`)
			.attr('stroke-width', 1.5);
		node
			.append('text')
			.attr('class', 'ngwa-force-label')
			.attr('dy', (d) => -(8 + Math.min(8, (d.degreeOut + d.degreeIn) * 0.8)))
			.attr('text-anchor', 'middle')
			.attr('fill', 'var(--fg-muted)')
			.text((d) => d.label)
			.style('display', 'none');

		const sim = forceSimulation<SimNode>(nodes)
			.force(
				'link',
				forceLink<SimNode, SimLink>(links)
					.id((d) => d.id)
					.distance((d) => (d.rel === 'gates' ? 120 : d.rel === 'delegates' ? 72 : 58))
					.strength(0.5)
			)
			.force('charge', forceManyBody().strength(-230))
			.force('center', forceCenter(W / 2, H / 2))
			.force(
				'collide',
				forceCollide<SimNode>().radius((d) => 14 + Math.min(8, (d.degreeOut + d.degreeIn) * 0.8))
			)
			.force('x', forceX(W / 2).strength(0.04))
			.force('y', forceY(H / 2).strength(0.05));

		sim.on('tick', () => {
			link.attr('d', (d) => {
				const s = d.source as SimNode;
				const t = d.target as SimNode;
				const dx = (t.x ?? 0) - (s.x ?? 0);
				const dy = (t.y ?? 0) - (s.y ?? 0);
				const dr = Math.sqrt(dx * dx + dy * dy) * 1.4;
				return `M${s.x},${s.y}A${dr},${dr} 0 0,1 ${t.x},${t.y}`;
			});
			node.attr('transform', (d) => `translate(${d.x},${d.y})`);
		});

		const zoomB: ZoomBehavior<SVGSVGElement, unknown> = d3zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.3, 5])
			.on('zoom', (ev) => {
				root.attr('transform', ev.transform.toString());
				if (api.current) api.current.k = ev.transform.k;
				if (ev.sourceEvent && draggedRef) draggedRef.current = true;
				refresh();
			});
		svg.call(zoomB);

		node.call(
			d3drag<SVGGElement, SimNode>()
				.on('start', (ev, d) => {
					if (!ev.active) sim.alphaTarget(0.3).restart();
					d.fx = d.x;
					d.fy = d.y;
					if (draggedRef) draggedRef.current = true;
				})
				.on('drag', (ev, d) => {
					d.fx = ev.x;
					d.fy = ev.y;
				})
				.on('end', (ev, d) => {
					if (!ev.active) sim.alphaTarget(0);
					d.fx = null;
					d.fy = null;
				})
		);

		// Reflect selRef + zoom into styling (called on select change + zoom).
		function refresh() {
			const { selected: sel, incident: inc } = selRef.current;
			const k = api.current?.k ?? 1;
			node.attr('opacity', (d) => (!sel || d.id === sel || inc?.nodes.has(d.id) ? 1 : 0.16));
			node
				.select('circle')
				.attr('stroke', (d) => (d.id === sel ? NGWA : `var(--nk-${d.kind})`))
				.attr('stroke-width', (d) => (d.id === sel ? 3 : 1.5));
			node.select('text').style('display', (d) => {
				if (sel) return d.id === sel || inc?.nodes.has(d.id) ? null : 'none';
				return k >= LABEL_ZOOM || d.degreeOut + d.degreeIn >= HUB_DEGREE ? null : 'none';
			});
			link
				.attr('stroke-opacity', (d) => {
					const s = (d.source as SimNode).id;
					const t = (d.target as SimNode).id;
					if (!sel) return 0.22;
					return s === sel || t === sel ? 0.9 : 0.03;
				})
				.attr('stroke', (d) => {
					const s = (d.source as SimNode).id;
					const t = (d.target as SimNode).id;
					if (sel && s === sel) return NGWA;
					if (sel && t === sel) return VERDIGRIS;
					return REL_COLOR[d.rel];
				})
				.attr('stroke-width', (d) => {
					const s = (d.source as SimNode).id;
					const t = (d.target as SimNode).id;
					return sel && (s === sel || t === sel) ? 2 : 1;
				});
		}

		api.current = { node, link, sim, k: 1, refresh };
		refresh();

		return () => {
			sim.stop();
		};
	}, [graph]);

	// Re-style on selection change (no rebuild / relayout).
	useEffect(() => {
		api.current?.refresh();
	}, [selected, incident]);

	return <svg ref={svgRef} className="ngwa-graph-svg" style={{ cursor: 'grab' }} />;
}

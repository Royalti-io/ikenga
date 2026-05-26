// Store map · Flow rail (Phase 4 · D-07 alt). Bipartite store↔scopes: Ọba
// entries on the left, scopes on the right, arcs tracing each entry's links
// (enabled = systemic, local = achievement, orphaned = dashed danger). One of
// two Store-map modes (see store-map.tsx); shares the model with the matrix.

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/components/ui/utils';
import {
	type Cell,
	entryLinks,
	STORE_KIND_GLYPH,
	type StoreModel,
	type StoreRow,
} from './store-model';

function arcColor(state: Cell): string {
	if (state === 'orphaned') return 'var(--st-orphaned)';
	if (state === 'local') return 'var(--st-local)';
	return 'var(--st-enabled)';
}

export function StoreFlow({ model }: { model: StoreModel }) {
	const { columns, rows, totals } = model;

	const stageRef = useRef<HTMLDivElement>(null);
	const entriesRef = useRef<HTMLDivElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const entryRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	const scopeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	const [paths, setPaths] = useState<
		{ id: string; rowKey: string; scope: string; state: Cell; d: string }[]
	>([]);
	const [active, setActive] = useState<string | null>(null); // entry key (click-pinned)
	const [hover, setHover] = useState<string | null>(null);
	const focus = hover ?? active;

	// Per-scope linked counts.
	const scopeCounts = useMemo(() => {
		const m = new Map<string, number>();
		for (const c of columns) m.set(c.key, 0);
		for (const r of rows) for (const l of entryLinks(r)) m.set(l.scope, (m.get(l.scope) ?? 0) + 1);
		return m;
	}, [columns, rows]);

	// Measure card centres → build arcs. The stage itself does NOT scroll (so
	// scopes stay pinned in view); the entries rail scrolls internally. Coords
	// are relative to the stage box; arcs are drawn only for entries currently
	// visible within the stage, so a long store doesn't fling arcs off-screen.
	useLayoutEffect(() => {
		const stage = stageRef.current;
		const entries = entriesRef.current;
		if (!stage) return;
		function measure() {
			const box = stage!.getBoundingClientRect();
			const svg = svgRef.current;
			if (svg) {
				svg.setAttribute('width', String(box.width));
				svg.setAttribute('height', String(box.height));
			}
			const next: typeof paths = [];
			for (const r of rows) {
				const ee = entryRefs.current.get(r.key);
				if (!ee) continue;
				const er = ee.getBoundingClientRect();
				const y1 = er.top + er.height / 2 - box.top;
				// Skip entries scrolled out of the stage viewport.
				if (y1 < 36 || y1 > box.height - 8) continue;
				const x1 = er.right - box.left;
				for (const l of entryLinks(r)) {
					const se = scopeRefs.current.get(l.scope);
					if (!se) continue;
					const sr = se.getBoundingClientRect();
					const x2 = sr.left - box.left;
					const y2 = sr.top + sr.height / 2 - box.top;
					const mx = (x1 + x2) / 2;
					next.push({
						id: `${r.key}->${l.scope}`,
						rowKey: r.key,
						scope: l.scope,
						state: l.state,
						d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
					});
				}
			}
			setPaths(next);
		}
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(stage);
		entries?.addEventListener('scroll', measure, { passive: true });
		return () => {
			ro.disconnect();
			entries?.removeEventListener('scroll', measure);
		};
	}, [rows]);

	if (rows.length === 0) {
		return (
			<div className="ngwa-analyze-empty">
				No store-backed primitives yet. Import agents, skills, or commands into Ọba to populate the
				store map.
			</div>
		);
	}

	const focusRow = focus ? rows.find((r) => r.key === focus) : null;
	const focusScopes = new Set(focusRow ? entryLinks(focusRow).map((l) => l.scope) : []);

	return (
		<div className="ngwa-matrix-wrap">
			<div className="ngwa-flow-summary">
				<div className="sc">
					<div className="n">{totals.rows}</div>
					<div className="l">Store entries</div>
				</div>
				<div className="sc" style={{ color: 'var(--st-enabled)' }}>
					<div className="n">{totals.enabled}</div>
					<div className="l">Enabled</div>
				</div>
				<div className="sc" style={{ color: 'var(--st-local)' }}>
					<div className="n">{totals.local}</div>
					<div className="l">Local · not in Ọba</div>
				</div>
				<div className="sc" style={{ color: 'var(--st-orphaned)' }}>
					<div className="n">{totals.orphaned}</div>
					<div className="l">Orphaned</div>
				</div>
				<div className="sc">
					<div className="n">{totals.symlinks}</div>
					<div className="l">Active symlinks</div>
				</div>
			</div>
			<div className="ngwa-flow-stage" ref={stageRef} onClick={() => setActive(null)}>
				<svg className="ngwa-flow-arcs" ref={svgRef}>
					{paths.map((p) => {
						const lit = focus === p.rowKey;
						const dim = focus !== null && !lit;
						return (
							<path
								key={p.id}
								d={p.d}
								fill="none"
								stroke={arcColor(p.state)}
								strokeWidth={lit ? 2.2 : 1.3}
								strokeOpacity={dim ? 0.06 : lit ? 0.9 : 0.3}
								strokeDasharray={p.state === 'orphaned' ? '5,4' : undefined}
							/>
						);
					})}
				</svg>
				<div className="ngwa-flow-cols">
					<div className="ngwa-flow-rail entries" ref={entriesRef}>
						<div className="ngwa-flow-railh">Ọba · store</div>
						{rows.map((r) => (
							<StoreEntryCard
								key={r.key}
								row={r}
								active={active === r.key}
								dim={focus !== null && focus !== r.key}
								onEnter={() => setHover(r.key)}
								onLeave={() => setHover((h) => (h === r.key ? null : h))}
								onClick={() => setActive((a) => (a === r.key ? null : r.key))}
								cardRef={(el) => {
									if (el) entryRefs.current.set(r.key, el);
									else entryRefs.current.delete(r.key);
								}}
							/>
						))}
					</div>
					<div className="ngwa-flow-rail scopes">
						<div className="ngwa-flow-railh">Scopes</div>
						<div className="ngwa-flow-scopestack">
							{columns.map((c) => {
								const count = scopeCounts.get(c.key) ?? 0;
								return (
									<div
										key={c.key}
										className={cn(
											'ngwa-flow-scope',
											focus && focusScopes.has(c.key) && 'lit',
											focus && !focusScopes.has(c.key) && 'dim',
											count === 0 && 'empty'
										)}
										ref={(el) => {
											if (el) scopeRefs.current.set(c.key, el);
											else scopeRefs.current.delete(c.key);
										}}
									>
										<span className="ngwa-flow-scope-ic">{c.key === 'workspace' ? '◉' : '▣'}</span>
										<span className="ngwa-flow-scope-nm">{c.label}</span>
										<span className="ngwa-flow-scope-ct">{count}</span>
									</div>
								);
							})}
						</div>
					</div>
				</div>
				<div className="ngwa-flow-hint">Hover or click an Ọba entry to trace its scope links</div>
			</div>
		</div>
	);
}

function StoreEntryCard({
	row,
	active,
	dim,
	onEnter,
	onLeave,
	onClick,
	cardRef,
}: {
	row: StoreRow;
	active: boolean;
	dim: boolean;
	onEnter: () => void;
	onLeave: () => void;
	onClick: () => void;
	cardRef: (el: HTMLDivElement | null) => void;
}) {
	return (
		<div
			ref={cardRef}
			className={cn('ngwa-flow-entry', active && 'sel', dim && 'dim')}
			style={{ ['--accent' as string]: `var(--nk-${row.kind})` }}
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
			onClick={(ev) => {
				ev.stopPropagation();
				onClick();
			}}
		>
			<span className="ngwa-flow-entry-ic">{STORE_KIND_GLYPH[row.kind]}</span>
			<span className="ngwa-flow-entry-nm">{row.name}</span>
			<span className={cn('ngwa-flow-entry-st', row.status)} />
		</div>
	);
}

// Store map · Presence matrix (Phase 4 · D-07). Store-backed primitives (rows,
// grouped by kind) × scopes (columns); each cell encodes on-disk state
// (enabled / local / orphaned / none). One of two Store-map modes (see
// store-map.tsx); shares the model with the Flow rail.

import { Fragment, useState } from 'react';
import { cn } from '@/components/ui/utils';
import { STORE_KIND_GLYPH, STORE_KIND_LABEL, type StoreModel } from './store-model';

export function StoreMatrix({ model }: { model: StoreModel }) {
	const { columns, groups, totals } = model;
	const [hovered, setHovered] = useState<string | null>(null);

	if (groups.length === 0) {
		return (
			<div className="ngwa-analyze-empty">
				No store-backed primitives yet. Import agents, skills, or commands into Ọba to populate the
				store map.
			</div>
		);
	}

	return (
		<div className="ngwa-matrix-wrap">
			<table className="ngwa-matrix">
				<thead>
					<tr>
						<th className="ngwa-mx-corner">Ọba entry ↓ / scope →</th>
						{columns.map((c) => (
							<th key={c.key} className={cn('ngwa-mx-colh', hovered === `col:${c.key}` && 'lit')}>
								<div className="ngwa-mx-colcard">
									<span className="ngwa-mx-colnm">{c.label}</span>
								</div>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{groups.map((g) => (
						<Fragment key={`k:${g.kind}`}>
							<tr className="ngwa-mx-kindrow">
								<td>
									<span className="ngwa-mx-kindlbl">
										<span className="kd" style={{ background: `var(--nk-${g.kind})` }} />
										{STORE_KIND_LABEL[g.kind]}
										<span className="ct">{g.rows.length}</span>
									</span>
								</td>
								<td colSpan={columns.length} />
							</tr>
							{g.rows.map((r) => (
								<tr
									key={r.key}
									className={cn(hovered === `row:${r.key}` && 'lit')}
									onMouseEnter={() => setHovered(`row:${r.key}`)}
									onMouseLeave={() => setHovered(null)}
								>
									<td className="ngwa-mx-rowh">
										<div className="ngwa-mx-rowcard">
											<span className="ngwa-mx-ic" style={{ color: `var(--nk-${r.kind})` }}>
												{STORE_KIND_GLYPH[r.kind]}
											</span>
											<span className="ngwa-mx-nm">{r.name}</span>
											<span className={cn('ngwa-mx-st', r.status)}>{r.status}</span>
										</div>
									</td>
									{columns.map((c) => {
										const v = r.cells.get(c.key) ?? 'none';
										return (
											<td
												key={c.key}
												className="ngwa-mx-cell"
												onMouseEnter={() => setHovered(`col:${c.key}`)}
											>
												<span
													className={cn(
														'ngwa-mx-dot',
														v === 'enabled' && 'on',
														v === 'local' && 'local',
														v === 'orphaned' && 'orphan',
														(v === 'none' || v === 'disabled') && 'off'
													)}
													title={`${r.name} · ${c.label}: ${v}`}
												>
													<span className="mark" />
												</span>
											</td>
										);
									})}
								</tr>
							))}
						</Fragment>
					))}
				</tbody>
			</table>
			<div className="ngwa-matrix-foot">
				<span>
					<b>{totals.rows}</b> store entries × <b>{totals.scopes}</b> scopes
				</span>
				<span className="sep">|</span>
				<span style={{ color: 'var(--st-enabled)' }}>
					<b>{totals.enabled}</b> enabled
				</span>
				<span className="sep">|</span>
				<span style={{ color: 'var(--st-local)' }}>
					<b>{totals.local}</b> local
				</span>
				{totals.orphaned > 0 && (
					<>
						<span className="sep">|</span>
						<span style={{ color: 'var(--st-orphaned)' }}>
							⚠ <b>{totals.orphaned}</b> orphaned
						</span>
					</>
				)}
			</div>
		</div>
	);
}

// Store map (Phase 4 · D-07) — the Ngwa Analyze "Store map" surface, rendered
// as a PRESENCE MATRIX: store-backed primitives (rows, grouped by kind) ×
// scopes (columns). Each cell encodes the on-disk state of that primitive in
// that scope: enabled (symlinked from Ọba), local (real file, not in store),
// orphaned (dangling symlink), or none. Realizes the G-09 store surface as an
// analysis view. No graph lib — a styled grid.
//
// Reuses the `NgwaItem[]` model (`buildItems`) for per-(name,scope) state and
// the store catalog for store-backed rows + disabled (linked-nowhere) entries.

import { Fragment, useMemo, useState } from 'react';
import { cn } from '@/components/ui/utils';
import type { ClaudeStoreEntry, ClaudeStoreKind } from '@/lib/tauri-cmd';
import type { ItemState, NgwaItem } from '../ngwa-surface';

const KIND_GLYPH: Record<string, string> = { agent: '★', skill: '◆', command: '⌘' };
const KIND_LABEL: Record<string, string> = {
	agent: 'Agents',
	skill: 'Skills',
	command: 'Commands',
};
// Only file-based (symlink-farm) kinds participate in the store map; hooks/mcps
// are JSON-merge primitives, not Ọba symlink entries.
const FILE_KINDS: ClaudeStoreKind[] = ['skill', 'agent', 'command'];
const KIND_ORDER: ClaudeStoreKind[] = ['skill', 'agent', 'command'];

/** Per-cell presence: a scan state, or 'none' when absent in that scope. */
type Cell = ItemState | 'none';

interface MatrixRow {
	key: string;
	kind: ClaudeStoreKind;
	name: string;
	inStore: boolean;
	cells: Map<string, Cell>; // scopeKey → cell
	status: ItemState; // row-level badge
}

interface StoreMatrixProps {
	items: NgwaItem[];
	store: ClaudeStoreEntry[];
}

function rowStatus(cells: Map<string, Cell>, inStore: boolean): ItemState {
	const vals = [...cells.values()];
	if (vals.includes('enabled')) return 'enabled';
	if (vals.includes('orphaned')) return 'orphaned';
	if (vals.includes('local')) return 'local';
	return inStore ? 'disabled' : 'local';
}

export function StoreMatrix({ items, store }: StoreMatrixProps) {
	const { columns, groups, totals } = useMemo(() => {
		const fileItems = items.filter((i) => FILE_KINDS.includes(i.storeKind));

		// Columns: every scope key seen in items + store.enabledIn, 'workspace' first.
		const labelByScope = new Map<string, string>();
		labelByScope.set('workspace', 'Personal');
		const scopeSet = new Set<string>(['workspace']);
		for (const it of fileItems) {
			scopeSet.add(it.scopeKey);
			labelByScope.set(it.scopeKey, it.scopeLabel);
		}
		for (const e of store) {
			if (!FILE_KINDS.includes(e.kind)) continue;
			for (const sc of e.enabledIn) scopeSet.add(sc);
		}
		const columns = [...scopeSet].sort((a, b) => {
			if (a === 'workspace') return -1;
			if (b === 'workspace') return 1;
			return (labelByScope.get(a) ?? a).localeCompare(labelByScope.get(b) ?? b);
		});

		// Rows keyed by kind:name.
		const rowMap = new Map<string, MatrixRow>();
		const storeByKey = new Map<string, ClaudeStoreEntry>();
		for (const e of store)
			if (FILE_KINDS.includes(e.kind)) storeByKey.set(`${e.kind}:${e.name}`, e);

		const ensureRow = (kind: ClaudeStoreKind, name: string): MatrixRow => {
			const key = `${kind}:${name}`;
			let r = rowMap.get(key);
			if (!r) {
				r = {
					key,
					kind,
					name,
					inStore: storeByKey.has(key),
					cells: new Map(),
					status: 'disabled',
				};
				rowMap.set(key, r);
			}
			return r;
		};

		// Fill cells from scan items (on-disk ground truth).
		for (const it of fileItems) {
			const r = ensureRow(it.storeKind, it.name);
			// item.state is enabled|local|orphaned for link items.
			r.cells.set(it.scopeKey, it.state);
		}
		// Ensure store-backed rows exist even when linked nowhere on disk.
		for (const e of store) {
			if (!FILE_KINDS.includes(e.kind)) continue;
			ensureRow(e.kind, e.name);
		}
		// Fill 'none' for missing cells + compute status.
		for (const r of rowMap.values()) {
			for (const c of columns) if (!r.cells.has(c)) r.cells.set(c, 'none');
			r.status = rowStatus(r.cells, r.inStore);
		}

		// Group rows by kind, sorted by name.
		const groups = KIND_ORDER.map((kind) => ({
			kind,
			rows: [...rowMap.values()]
				.filter((r) => r.kind === kind)
				.sort((a, b) => a.name.localeCompare(b.name)),
		})).filter((g) => g.rows.length > 0);

		// Totals for footer.
		let enabled = 0;
		let local = 0;
		let orphaned = 0;
		let disabled = 0;
		for (const r of rowMap.values()) {
			for (const v of r.cells.values()) {
				if (v === 'enabled') enabled++;
				else if (v === 'local') local++;
				else if (v === 'orphaned') orphaned++;
			}
			if (r.status === 'disabled') disabled++;
		}
		const totals = {
			rows: rowMap.size,
			scopes: columns.length,
			enabled,
			local,
			orphaned,
			disabled,
			labelByScope,
		};
		return { columns, groups, totals };
	}, [items, store]);

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
							<th key={c} className={cn('ngwa-mx-colh', hovered === `col:${c}` && 'lit')}>
								<div className="ngwa-mx-colcard">
									<span className="ngwa-mx-colnm">{totals.labelByScope.get(c) ?? c}</span>
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
										{KIND_LABEL[g.kind]}
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
												{KIND_GLYPH[r.kind]}
											</span>
											<span className="ngwa-mx-nm">{r.name}</span>
											<span className={cn('ngwa-mx-st', r.status)}>{r.status}</span>
										</div>
									</td>
									{columns.map((c) => {
										const v = r.cells.get(c) ?? 'none';
										return (
											<td
												key={c}
												className="ngwa-mx-cell"
												onMouseEnter={() => setHovered(`col:${c}`)}
											>
												<span
													className={cn(
														'ngwa-mx-dot',
														v === 'enabled' && 'on',
														v === 'local' && 'local',
														v === 'orphaned' && 'orphan',
														(v === 'none' || v === 'disabled') && 'off'
													)}
													title={`${r.name} · ${totals.labelByScope.get(c) ?? c}: ${v}`}
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

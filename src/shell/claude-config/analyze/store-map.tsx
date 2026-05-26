// Store map (Phase 4 · D-07) — wrapper that owns the model build + filters +
// a Matrix / Flow mode toggle. Matrix is the default (locked baseline); Flow is
// the bipartite arc-rail alternate. Filters: free-text name search + a scope
// narrow (its own columns, reliable regardless of sidebar scope grammar).

import { useMemo, useState } from 'react';
import { cn } from '@/components/ui/utils';
import type { ClaudeStoreEntry } from '@/lib/tauri-cmd';
import type { NgwaItem } from '../ngwa-surface';
import { StoreFlow } from './store-flow';
import { StoreMatrix } from './store-matrix';
import { buildStoreModel, filterStoreModel } from './store-model';

type StoreMode = 'matrix' | 'flow';

interface StoreMapProps {
	items: NgwaItem[];
	store: ClaudeStoreEntry[];
}

export function StoreMap({ items, store }: StoreMapProps) {
	const [mode, setMode] = useState<StoreMode>('matrix');
	const [query, setQuery] = useState('');
	const [scope, setScope] = useState<string>('all');

	const full = useMemo(() => buildStoreModel(items, store), [items, store]);
	const model = useMemo(() => filterStoreModel(full, { query, scope }), [full, query, scope]);

	return (
		<div className="ngwa-graph">
			<div className="ngwa-graph-toolbar">
				<div className="ngwa-seg" role="group" aria-label="Store-map layout">
					<button
						type="button"
						className={cn(mode === 'matrix' && 'on')}
						onClick={() => setMode('matrix')}
						title="Presence matrix — entries × scopes grid"
					>
						▦ Matrix
					</button>
					<button
						type="button"
						className={cn(mode === 'flow' && 'on')}
						onClick={() => setMode('flow')}
						title="Flow rail — bipartite store↔scope arcs"
					>
						⤳ Flow
					</button>
				</div>
				<div className="ngwa-graph-meta">
					{model.totals.rows} entries · {model.totals.symlinks} links
				</div>
				<input
					className="ngwa-graph-search"
					placeholder="filter entries…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<select
					className="ngwa-graph-select"
					value={scope}
					onChange={(e) => setScope(e.target.value)}
					title="Narrow to one scope"
				>
					<option value="all">All scopes</option>
					{full.columns.map((c) => (
						<option key={c.key} value={c.key}>
							{c.label}
						</option>
					))}
				</select>
				<div className="ngwa-graph-spacer" />
			</div>
			<div className="ngwa-graph-stage" style={{ background: 'var(--bg-base)' }}>
				{mode === 'matrix' ? <StoreMatrix model={model} /> : <StoreFlow model={model} />}
			</div>
		</div>
	);
}

// Analyze surfaces router (Phase 4). Routes the Ngwa ANALYZE sidebar surfaces
// to their view. First cut ships two — capability graph (D-06) + store map
// (D-07); the other three stay placeholders until a later pass.

import type { ClaudeConfig, ClaudeStoreEntry } from '@/lib/tauri-cmd';
import type { NgwaItem, NgwaSurfaceId } from '../ngwa-surface';
import { GraphView } from './graph-view';
import { StoreMatrix } from './store-matrix';

const SOON_LABEL: Record<string, string> = {
	life: 'Hook lifecycle',
	health: 'Inventory & health',
	flow: 'Orchestration flow',
};

interface AnalyzeSurfaceProps {
	surface: NgwaSurfaceId;
	config: ClaudeConfig | null;
	scope: string;
	items: NgwaItem[];
	store: ClaudeStoreEntry[];
}

export function AnalyzeSurface({ surface, config, scope, items, store }: AnalyzeSurfaceProps) {
	if (surface === 'graph') return <GraphView config={config} scope={scope} />;
	if (surface === 'map') return <StoreMatrix items={items} store={store} />;

	return (
		<div className="ngwa-soon">
			<span className="badge">Coming in a later Phase-4 pass</span>
			<div style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: 'var(--fg)' }}>
				{SOON_LABEL[surface] ?? 'Analyze'}
			</div>
			<div style={{ maxWidth: 420, lineHeight: 1.6, fontSize: 12 }}>
				The capability graph and store map are live now. Hook lifecycle, inventory &amp; health, and
				orchestration flow land in a later Phase-4 pass.
			</div>
		</div>
	);
}

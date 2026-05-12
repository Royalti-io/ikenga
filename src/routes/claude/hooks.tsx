import { createFileRoute } from '@tanstack/react-router';
import { Fragment, useMemo, useState } from 'react';

import { useClaudeRoute } from './route';
import { ListDetail, Row, SearchToolbar, EmptyDetail } from '@/shell/claude-config/list-detail';
import { HookDetailView } from '@/shell/claude-config/detail-views';

export const Route = createFileRoute('/claude/hooks')({
	component: HooksTab,
});

function HooksTab() {
	const { config, isLoading, onEdit } = useClaudeRoute();
	const [filter, setFilter] = useState('');
	const [eventFilter, setEventFilter] = useState<string>('all');
	const [selected, setSelected] = useState<string | null>(null);

	const allEvents = useMemo(() => {
		const set = new Set<string>();
		config?.hooks.forEach((h) => set.add(h.event));
		return [...set].sort();
	}, [config]);

	const items = useMemo(() => {
		if (!config) return [];
		let xs = config.hooks;
		if (eventFilter !== 'all') xs = xs.filter((h) => h.event === eventFilter);
		if (filter.trim()) {
			const f = filter.toLowerCase();
			xs = xs.filter(
				(h) =>
					h.name.toLowerCase().includes(f) ||
					h.event.toLowerCase().includes(f) ||
					(h.commandRaw ?? '').toLowerCase().includes(f)
			);
		}
		return xs;
	}, [config, filter, eventFilter]);

	// Group by event for list rendering.
	const grouped = useMemo(() => {
		const m = new Map<string, typeof items>();
		for (const h of items) {
			const k = h.event;
			const arr = m.get(k) ?? [];
			arr.push(h);
			m.set(k, arr);
		}
		return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
	}, [items]);

	const selectedHook = useMemo(() => {
		if (!items.length) return null;
		return items.find((h) => keyOf(h) === selected) ?? items[0];
	}, [items, selected]);

	return (
		<ListDetail
			toolbar={
				<SearchToolbar
					value={filter}
					onChange={setFilter}
					placeholder={`Filter ${config?.hooks.length ?? 0} hooks…`}
					trailing={
						<select
							className="ccfg-list-select"
							value={eventFilter}
							onChange={(e) => setEventFilter(e.target.value)}
						>
							<option value="all">All events</option>
							{allEvents.map((ev) => (
								<option key={ev} value={ev}>
									{ev}
								</option>
							))}
						</select>
					}
				/>
			}
			meta={
				<div className="ccfg-list-meta">
					<span>
						{items.length} hooks · {allEvents.length} events
					</span>
					<span>sort: event</span>
				</div>
			}
			list={
				isLoading ? (
					<div className="ccfg-empty">Loading…</div>
				) : items.length === 0 ? (
					<div className="ccfg-empty">No hooks match.</div>
				) : (
					grouped.map(([ev, list]) => (
						<Fragment key={ev}>
							<div className="ccfg-event-head">
								<span>{ev}</span>
								<span className="ct">{list.length}</span>
							</div>
							{list.map((h) => (
								<Row
									key={keyOf(h)}
									active={!!selectedHook && keyOf(selectedHook) === keyOf(h)}
									onClick={() => setSelected(keyOf(h))}
									name={h.name}
									scope={h.scope}
									description={`type: ${h.type}${h.commandRaw ? ` · ${h.commandRaw}` : ''}`}
								/>
							))}
						</Fragment>
					))
				)
			}
			detail={
				selectedHook ? (
					<HookDetailView hook={selectedHook} onEdit={onEdit} />
				) : (
					<EmptyDetail message="Select a hook to view its config." />
				)
			}
		/>
	);
}

function keyOf(h: { event: string; name: string; settingsPath: string }): string {
	return `${h.event}:${h.settingsPath}:${h.name}`;
}

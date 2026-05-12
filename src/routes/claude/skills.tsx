import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { useClaudeRoute } from './route';
import { ListDetail, Row, SearchToolbar, EmptyDetail } from '@/shell/claude-config/list-detail';
import { SkillDetailView } from '@/shell/claude-config/detail-views';

export const Route = createFileRoute('/claude/skills')({
	component: SkillsTab,
});

function SkillsTab() {
	const { config, isLoading, onEdit } = useClaudeRoute();
	const [filter, setFilter] = useState('');
	const [scopeFilter, setScopeFilter] = useState<'all' | 'project' | 'personal'>('all');
	const [selected, setSelected] = useState<string | null>(null);

	const items = useMemo(() => {
		if (!config) return [];
		let xs = config.skills;
		if (scopeFilter !== 'all') xs = xs.filter((s) => s.scope === scopeFilter);
		if (filter.trim()) {
			const f = filter.toLowerCase();
			xs = xs.filter(
				(s) => s.name.toLowerCase().includes(f) || (s.description ?? '').toLowerCase().includes(f)
			);
		}
		return xs;
	}, [config, filter, scopeFilter]);

	const selectedSkill = useMemo(() => {
		if (!items.length) return null;
		const found = items.find((s) => keyOf(s) === selected);
		return found ?? items[0];
	}, [items, selected]);

	const projectCount = config?.skills.filter((s) => s.scope === 'project').length ?? 0;
	const personalCount = config?.skills.filter((s) => s.scope === 'personal').length ?? 0;

	return (
		<ListDetail
			toolbar={
				<SearchToolbar
					value={filter}
					onChange={setFilter}
					placeholder={`Filter ${config?.skills.length ?? 0} skills…`}
					trailing={
						<select
							className="ccfg-list-select"
							value={scopeFilter}
							onChange={(e) => setScopeFilter(e.target.value as 'all' | 'project' | 'personal')}
						>
							<option value="all">All</option>
							<option value="project">Project ({projectCount})</option>
							<option value="personal">Personal ({personalCount})</option>
						</select>
					}
				/>
			}
			meta={
				<div className="ccfg-list-meta">
					<span>
						{items.length} skills · {personalCount} personal
					</span>
					<span>sort: name</span>
				</div>
			}
			list={
				isLoading ? (
					<div className="ccfg-empty">Loading…</div>
				) : items.length === 0 ? (
					<div className="ccfg-empty">No skills match.</div>
				) : (
					items.map((s) => (
						<Row
							key={keyOf(s)}
							active={!!selectedSkill && keyOf(selectedSkill) === keyOf(s)}
							onClick={() => setSelected(keyOf(s))}
							name={s.name}
							scope={s.scope}
							description={s.description}
							overridden={!!s.overriddenBy}
						/>
					))
				)
			}
			detail={
				selectedSkill ? (
					<SkillDetailView skill={selectedSkill} onEdit={onEdit} />
				) : (
					<EmptyDetail message="Select a skill to view its config." />
				)
			}
		/>
	);
}

function keyOf(s: { name: string; scope: string; projectRoot: string | null }): string {
	return `${s.scope}:${s.projectRoot ?? ''}:${s.name}`;
}

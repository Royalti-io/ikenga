import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { useClaudeRoute } from './route';
import {
  ListDetail,
  Row,
  SearchToolbar,
  EmptyDetail,
} from '@/shell/claude-config/list-detail';
import { AgentDetailView } from '@/shell/claude-config/detail-views';

export const Route = createFileRoute('/claude/')({
  component: AgentsTab,
});

function AgentsTab() {
  const { config, isLoading, onEdit, onNewSession } = useClaudeRoute();
  const [filter, setFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'project' | 'personal'>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const items = useMemo(() => {
    if (!config) return [];
    let xs = config.agents;
    if (scopeFilter !== 'all') xs = xs.filter((a) => a.scope === scopeFilter);
    if (filter.trim()) {
      const f = filter.toLowerCase();
      xs = xs.filter(
        (a) =>
          a.name.toLowerCase().includes(f) ||
          (a.description ?? '').toLowerCase().includes(f),
      );
    }
    return xs;
  }, [config, filter, scopeFilter]);

  // Auto-select first when nothing selected.
  const selectedAgent = useMemo(() => {
    if (!items.length) return null;
    const found = items.find((a) => keyOf(a) === selected);
    return found ?? items[0];
  }, [items, selected]);

  const projectCount = config?.agents.filter((a) => a.scope === 'project').length ?? 0;
  const personalCount = config?.agents.filter((a) => a.scope === 'personal').length ?? 0;

  return (
    <ListDetail
      toolbar={
        <SearchToolbar
          value={filter}
          onChange={setFilter}
          placeholder={`Filter ${config?.agents.length ?? 0} agents…`}
          trailing={
            <select
              className="ccfg-list-select"
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value as 'all' | 'project' | 'personal')}
            >
              <option value="all">All scopes</option>
              <option value="project">Project ({projectCount})</option>
              <option value="personal">Personal ({personalCount})</option>
            </select>
          }
        />
      }
      meta={
        <div className="ccfg-list-meta">
          <span>
            {items.length} agents · {personalCount} personal
          </span>
          <span>sort: name</span>
        </div>
      }
      list={
        isLoading ? (
          <div className="ccfg-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="ccfg-empty">No agents match.</div>
        ) : (
          items.map((a) => {
            const k = keyOf(a);
            const allowedTools = Array.isArray(a.frontmatter['allowed-tools'])
              ? (a.frontmatter['allowed-tools'] as unknown[]).length
              : 0;
            return (
              <Row
                key={k}
                active={!!selectedAgent && keyOf(selectedAgent) === k}
                onClick={() => setSelected(k)}
                name={a.name}
                scope={a.scope}
                description={a.description}
                overridden={!!a.overriddenBy}
                meta={
                  <>
                    {a.model && <span>{a.model}</span>}
                    {a.model && <span>·</span>}
                    <span className="ct">{allowedTools} tools</span>
                  </>
                }
              />
            );
          })
        )
      }
      detail={
        selectedAgent ? (
          <AgentDetailView
            agent={selectedAgent}
            onEdit={onEdit}
            onNewSession={onNewSession}
          />
        ) : (
          <EmptyDetail message="Select an agent to view its config." />
        )
      }
    />
  );
}

function keyOf(a: { name: string; scope: string; projectRoot: string | null }): string {
  return `${a.scope}:${a.projectRoot ?? ''}:${a.name}`;
}

import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { useClaudeRoute } from './route';
import {
  ListDetail,
  Row,
  SearchToolbar,
  EmptyDetail,
} from '@/shell/claude-config/list-detail';
import { McpDetailView } from '@/shell/claude-config/detail-views';

export const Route = createFileRoute('/claude/mcps')({
  component: McpsTab,
});

function McpsTab() {
  const { config, isLoading, onEdit } = useClaudeRoute();
  const [filter, setFilter] = useState('');
  const [transportFilter, setTransportFilter] = useState<string>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const allTransports = useMemo(() => {
    const s = new Set<string>();
    config?.mcps.forEach((m) => s.add(m.transport));
    return [...s].sort();
  }, [config]);

  const items = useMemo(() => {
    if (!config) return [];
    let xs = config.mcps;
    if (transportFilter !== 'all') xs = xs.filter((m) => m.transport === transportFilter);
    if (filter.trim()) {
      const f = filter.toLowerCase();
      xs = xs.filter(
        (m) =>
          m.name.toLowerCase().includes(f) ||
          (m.command ?? '').toLowerCase().includes(f) ||
          (m.url ?? '').toLowerCase().includes(f),
      );
    }
    return xs;
  }, [config, filter, transportFilter]);

  const selectedMcp = useMemo(() => {
    if (!items.length) return null;
    return items.find((m) => keyOf(m) === selected) ?? items[0];
  }, [items, selected]);

  return (
    <ListDetail
      toolbar={
        <SearchToolbar
          value={filter}
          onChange={setFilter}
          placeholder={`Filter ${config?.mcps.length ?? 0} MCP servers…`}
          trailing={
            <select
              className="ccfg-list-select"
              value={transportFilter}
              onChange={(e) => setTransportFilter(e.target.value)}
            >
              <option value="all">All</option>
              {allTransports.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          }
        />
      }
      meta={
        <div className="ccfg-list-meta">
          <span>{items.length} servers</span>
          <span>sort: name</span>
        </div>
      }
      list={
        isLoading ? (
          <div className="ccfg-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="ccfg-empty">No MCP servers configured.</div>
        ) : (
          items.map((m) => (
            <Row
              key={keyOf(m)}
              active={!!selectedMcp && keyOf(selectedMcp) === keyOf(m)}
              onClick={() => setSelected(keyOf(m))}
              name={m.name}
              scope={m.scope}
              description={
                m.transport === 'stdio'
                  ? `${m.command ?? '?'} ${m.args.slice(0, 2).join(' ')}`.trim()
                  : (m.url ?? '')
              }
              meta={
                <>
                  <span className="ct">{m.transport}</span>
                  {m.envKeys.length > 0 && (
                    <>
                      <span>·</span>
                      <span className="ct">{m.envKeys.length} env</span>
                    </>
                  )}
                </>
              }
            />
          ))
        )
      }
      detail={
        selectedMcp ? (
          <McpDetailView mcp={selectedMcp} onEdit={onEdit} />
        ) : (
          <EmptyDetail message="Select an MCP server to view its config." />
        )
      }
    />
  );
}

function keyOf(m: { name: string; scope: string; path: string }): string {
  return `${m.scope}:${m.path}:${m.name}`;
}

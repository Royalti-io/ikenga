import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { useClaudeRoute } from './route';
import {
  ListDetail,
  Row,
  SearchToolbar,
  EmptyDetail,
} from '@/shell/claude-config/list-detail';
import { CommandDetailView } from '@/shell/claude-config/detail-views';

export const Route = createFileRoute('/claude/commands')({
  component: CommandsTab,
});

function CommandsTab() {
  const { config, isLoading, onEdit, onRunCommand } = useClaudeRoute();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const items = useMemo(() => {
    if (!config) return [];
    let xs = config.commands;
    if (filter.trim()) {
      const f = filter.toLowerCase();
      xs = xs.filter(
        (c) =>
          c.name.toLowerCase().includes(f) ||
          (c.description ?? '').toLowerCase().includes(f),
      );
    }
    return xs;
  }, [config, filter]);

  const selectedCmd = useMemo(() => {
    if (!items.length) return null;
    return items.find((c) => keyOf(c) === selected) ?? items[0];
  }, [items, selected]);

  return (
    <ListDetail
      toolbar={
        <SearchToolbar
          value={filter}
          onChange={setFilter}
          placeholder={`Filter ${config?.commands.length ?? 0} commands…`}
        />
      }
      meta={
        <div className="ccfg-list-meta">
          <span>{items.length} commands</span>
          <span>sort: name</span>
        </div>
      }
      list={
        isLoading ? (
          <div className="ccfg-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="ccfg-empty">No commands match.</div>
        ) : (
          items.map((c) => (
            <Row
              key={keyOf(c)}
              active={!!selectedCmd && keyOf(selectedCmd) === keyOf(c)}
              onClick={() => setSelected(keyOf(c))}
              name={`/${c.name}`}
              scope={c.scope}
              description={c.description}
              overridden={!!c.overriddenBy}
            />
          ))
        )
      }
      detail={
        selectedCmd ? (
          <CommandDetailView cmd={selectedCmd} onEdit={onEdit} onRun={onRunCommand} />
        ) : (
          <EmptyDetail message="Select a command to view its prompt." />
        )
      }
    />
  );
}

function keyOf(c: { name: string; scope: string; projectRoot: string | null }): string {
  return `${c.scope}:${c.projectRoot ?? ''}:${c.name}`;
}

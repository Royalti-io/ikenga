import { useMemo, useState } from 'react';
import {
  Outlet,
  createFileRoute,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckSquare,
  ChevronDown,
  Loader2,
  Plus,
  Search,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/query-keys';
import {
  TASKS_LIST_COLUMNS,
  type Task,
  type TaskStatus,
} from '@/lib/queries/tasks';

import './tasks.css';
import { TaskRow } from './_components/-task-row';
import { groupTasks, type GroupKey } from './-_shared';

const STATUS_OPTIONS: Array<{ value: '' | TaskStatus; label: string }> = [
  { value: '', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' },
];

function TasksLayout() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { taskId?: string };
  const selectedId = params.taskId ?? null;

  const [statusFilter, setStatusFilter] = useState<'' | TaskStatus>('');
  const [ownerFilter, setOwnerFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [showAutoClosed, setShowAutoClosed] = useState<boolean>(true);
  const [collapsed, setCollapsed] = useState<Set<GroupKey>>(new Set(['later']));

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.tasks.list(
      `${statusFilter || 'open'}|${ownerFilter}|${categoryFilter}|${
        showAutoClosed ? 'ac' : 'no-ac'
      }`,
    ),
    queryFn: async () => {
      let q = supabase
        .from('tasks')
        .select(TASKS_LIST_COLUMNS)
        .order('due_date', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(200);

      if (statusFilter) {
        q = q.eq('status', statusFilter);
      } else if (showAutoClosed) {
        // open + recently auto-closed
        q = q.or(
          'status.in.(pending,in_progress,blocked),and(status.eq.completed,outcome_notes.ilike.Auto-closed by task-health%)',
        );
      } else {
        q = q.in('status', ['pending', 'in_progress', 'blocked']);
      }
      if (ownerFilter) q = q.eq('assigned_to', ownerFilter);
      if (categoryFilter) q = q.eq('category', categoryFilter);
      if (search.trim()) q = q.ilike('title', `%${search.trim()}%`);

      const { data: rows, error: e } = await q;
      if (e) throw e;
      return (rows ?? []) as Task[];
    },
  });

  const groups = useMemo(
    () => (data ? groupTasks(data, showAutoClosed) : []),
    [data, showAutoClosed],
  );

  const openCount = useMemo(
    () =>
      data?.filter(
        (t) =>
          t.status !== 'completed' && t.status !== 'cancelled',
      ).length ?? 0,
    [data],
  );
  const autoClosedCount = useMemo(
    () =>
      data?.filter(
        (t) =>
          t.status === 'completed' &&
          t.outcome_notes?.startsWith('Auto-closed by task-health'),
      ).length ?? 0,
    [data],
  );

  function toggleGroup(key: GroupKey) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectTask(id: string) {
    void navigate({ to: '/tasks/$taskId', params: { taskId: id } });
  }

  return (
    <div className="flex h-full flex-col p-5">
      <div className="tk-frame flex-1">
        {/* Frame head */}
        <div className="tk-frame-head">
          <div className="tk-frame-title-wrap">
            <CheckSquare className="tk-frame-title-mark" />
            <div>
              <h2 className="tk-frame-title">
                Tasks
                <span className="tk-frame-count">
                  ({openCount} open · {autoClosedCount} auto-closed)
                </span>
              </h2>
              <div className="tk-frame-sub">
                Cross-cutting work — humans + agents. Click a row to inspect.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => navigate({ to: '/sweeper' })}
            >
              <CheckSquare className="h-3 w-3" />
              Sweeper queue
            </Button>
            <Button size="sm" type="button" disabled title="Not yet wired">
              <Plus className="h-3 w-3" />
              New task
            </Button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="tk-filterbar">
          <div className="input-search-wrap">
            <Search />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title…"
            />
          </div>
          <span className="label">Status</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | TaskStatus)}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="label">Owner</span>
          <select
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
          >
            <option value="">Anyone</option>
            <option value="nedjamez">Me</option>
            <option value="cfo-agent">cfo-agent</option>
            <option value="cmo-agent">cmo-agent</option>
            <option value="cto-agent">cto-agent</option>
            <option value="cpo-agent">cpo-agent</option>
            <option value="vp-sales-agent">vp-sales-agent</option>
            <option value="blog-writer">blog-writer</option>
          </select>
          <span className="label">Category</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="">All</option>
            <option value="sales">sales</option>
            <option value="finance">finance</option>
            <option value="marketing">marketing</option>
            <option value="technical">technical</option>
            <option value="product">product</option>
            <option value="communication">communication</option>
            <option value="operations">operations</option>
          </select>
          <button
            type="button"
            className={cn('tk-toggle', showAutoClosed && 'is-on')}
            onClick={() => setShowAutoClosed((v) => !v)}
          >
            <span className="checkbox" />
            Show auto-closed
          </button>
          <div className="spacer" />
          <span className="label">
            {openCount} open · {autoClosedCount} auto-closed
          </span>
        </div>

        {/* Master/detail body */}
        <div className="tk-split">
          <div className="tk-list">
            {isLoading && (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            )}
            {error instanceof Error && (
              <div className="m-4 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Failed to load tasks</p>
                  <p className="text-xs opacity-80">{error.message}</p>
                </div>
              </div>
            )}
            {data && data.length === 0 && !isLoading && (
              <div className="m-4 flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                No tasks match.
              </div>
            )}
            {groups.map((g) => {
              const isCollapsed = collapsed.has(g.key);
              return (
                <div key={g.key}>
                  <div
                    className={cn(
                      'tk-group-head',
                      g.key === 'overdue' && 'is-overdue',
                      g.key === 'autoclosed' && 'is-autoclosed',
                      isCollapsed && 'is-collapsed',
                    )}
                    onClick={() => toggleGroup(g.key)}
                  >
                    <span className="tk-group-label">
                      <ChevronDown className="chev" />
                      {g.label}
                    </span>
                    <span className="ct">{g.tasks.length}</span>
                  </div>
                  {!isCollapsed &&
                    g.tasks.map((t) => (
                      <TaskRow
                        key={t.id}
                        task={t}
                        selected={selectedId === t.id}
                        onSelect={selectTask}
                      />
                    ))}
                </div>
              );
            })}
          </div>

          <div className="tk-divider" />

          <div className="tk-detail">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/tasks')({
  component: TasksLayout,
});

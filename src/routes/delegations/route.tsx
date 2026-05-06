import { Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, AlertCircle, Loader2 } from 'lucide-react';

import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';
import { delegationsListQuery } from '@/lib/queries/delegations';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'blocked', label: 'Blocked' },
];

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'human', label: 'Human' },
  { value: 'agent', label: 'Agent' },
];

function statusColor(s: string): string {
  switch (s) {
    case 'assigned':
      return 'bg-gray-100 text-gray-700 border-gray-200';
    case 'in_progress':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    case 'completed':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'blocked':
      return 'bg-red-100 text-red-800 border-red-200';
    default:
      return 'bg-gray-100 text-gray-700 border-gray-200';
  }
}

function DelegationsLayout() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { id?: string };
  const selectedId = params.id ?? null;

  const [status, setStatus] = useState('');
  const [delegateType, setDelegateType] = useState('');
  const [search, setSearch] = useState('');

  const { data, isLoading, error } = useQuery(
    delegationsListQuery({ status, delegateType, search }),
  );

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Delegations</h1>
          {data && (
            <span className="text-sm text-muted-foreground">
              ({data.length})
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Tasks delegated to humans or agents.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search task title or notes…"
            className="w-72 rounded-md border border-input bg-background px-3 py-1 text-sm"
          />

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Type
            <select
              value={delegateType}
              onChange={(e) => setDelegateType(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {error instanceof Error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load delegations</p>
              <p className="text-xs opacity-80">{error.message}</p>
            </div>
          </div>
        )}

        {data && data.length === 0 && !isLoading && (
          <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            No delegations match.
          </div>
        )}

        {data && data.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Task</th>
                  <th className="px-3 py-2 text-left font-medium">Delegated to</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Assigned</th>
                  <th className="px-3 py-2 text-right font-medium">Completed</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() =>
                      navigate({ to: '/delegations/$id', params: { id: d.id } })
                    }
                    className={cn(
                      'cursor-pointer border-t border-border hover:bg-accent/50',
                      selectedId === d.id && 'bg-accent/40',
                    )}
                  >
                    <td className="px-3 py-2 align-top">
                      <div
                        className="max-w-[28rem] truncate font-medium"
                        title={d.tasks?.title ?? '—'}
                      >
                        {d.tasks?.title ?? '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-foreground">
                      {d.delegated_to}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge
                        variant="outline"
                        className={cn(
                          'border text-[10px] uppercase',
                          d.delegate_type === 'agent'
                            ? 'bg-purple-100 text-purple-800 border-purple-200'
                            : 'bg-blue-100 text-blue-800 border-blue-200',
                        )}
                      >
                        {d.delegate_type}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge
                        variant="outline"
                        className={cn(
                          'border text-[10px] uppercase',
                          statusColor(d.status),
                        )}
                      >
                        {d.status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 align-top text-right text-xs text-muted-foreground">
                      {d.assigned_at
                        ? new Date(d.assigned_at).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="px-3 py-2 align-top text-right text-xs text-muted-foreground">
                      {d.completed_at
                        ? new Date(d.completed_at).toLocaleDateString()
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Outlet />
    </div>
  );
}

export const Route = createFileRoute('/delegations')({
  component: DelegationsLayout,
});

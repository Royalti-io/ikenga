import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { queryKeys } from '@/lib/query-keys';
import {
  delegationDetailQuery,
  type DelegationStatus,
} from '@/lib/queries/delegations';

const STATUS_OPTIONS: DelegationStatus[] = [
  'assigned',
  'in_progress',
  'completed',
  'blocked',
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

function DelegationDetailSheet() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: delegation, isLoading, error } = useQuery(
    delegationDetailQuery(id),
  );

  const updateStatus = useMutation({
    mutationFn: async (status: DelegationStatus) => {
      const patch: { status: DelegationStatus; completed_at?: string | null } = {
        status,
      };
      if (status === 'completed') {
        patch.completed_at = new Date().toISOString();
      } else if (delegation?.completed_at) {
        patch.completed_at = null;
      }
      const { error } = await supabase
        .from('delegations')
        .update(patch)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.delegations.all });
    },
  });

  function close() {
    void navigate({ to: '/delegations' });
  }

  return (
    <Sheet open onOpenChange={(o) => !o && close()}>
      <SheetContent side="right" className="w-[40rem] max-w-[90vw] overflow-auto">
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
              <p className="font-medium">Failed to load delegation</p>
              <p className="text-xs opacity-80">{error.message}</p>
            </div>
          </div>
        )}

        {!isLoading && !error && !delegation && (
          <div className="text-sm text-muted-foreground">
            Delegation not found.
          </div>
        )}

        {delegation && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-6">
                {delegation.tasks?.title ?? 'Delegation'}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  variant="outline"
                  className={cn(
                    'border text-[10px] uppercase',
                    delegation.delegate_type === 'agent'
                      ? 'bg-purple-100 text-purple-800 border-purple-200'
                      : 'bg-blue-100 text-blue-800 border-blue-200',
                  )}
                >
                  {delegation.delegate_type}
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    'border text-[10px] uppercase',
                    statusColor(delegation.status),
                  )}
                >
                  {delegation.status.replace('_', ' ')}
                </Badge>
              </SheetDescription>
            </SheetHeader>

            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Status
                </dt>
                <dd>
                  <select
                    value={delegation.status}
                    disabled={updateStatus.isPending}
                    onChange={(e) =>
                      updateStatus.mutate(e.target.value as DelegationStatus)
                    }
                    className="mt-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </dd>
              </div>

              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Delegated to
                </dt>
                <dd>{delegation.delegated_to}</dd>
              </div>

              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Assigned
                </dt>
                <dd>
                  {delegation.assigned_at
                    ? new Date(delegation.assigned_at).toLocaleString()
                    : '—'}
                </dd>
              </div>

              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Completed
                </dt>
                <dd>
                  {delegation.completed_at
                    ? new Date(delegation.completed_at).toLocaleString()
                    : '—'}
                </dd>
              </div>

              {delegation.notes && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Notes
                  </dt>
                  <dd className="whitespace-pre-wrap">{delegation.notes}</dd>
                </div>
              )}

              {delegation.tasks && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Task
                  </dt>
                  <dd>
                    <button
                      onClick={() =>
                        navigate({
                          to: '/tasks/$taskId',
                          params: { taskId: delegation.task_id },
                        })
                      }
                      className="text-sm text-primary underline-offset-2 hover:underline"
                    >
                      {delegation.tasks.title}
                    </button>
                    {delegation.tasks.description && (
                      <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                        {delegation.tasks.description}
                      </p>
                    )}
                  </dd>
                </div>
              )}
            </dl>

            {updateStatus.isError && (
              <p className="mt-3 text-xs text-destructive">
                Failed to update status:{' '}
                {(updateStatus.error as Error).message}
              </p>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export const Route = createFileRoute('/delegations/$id')({
  component: DelegationDetailSheet,
});

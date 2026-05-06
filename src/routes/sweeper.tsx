import { useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, Check, Clock, RefreshCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { confidenceTier, loadLatestSweep, type SweepAction } from '@/lib/queries/sweeper';

import './tasks/tasks.css';
import { relativeAgo, shortId } from './tasks/-_shared';

function SweeperPage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['sweeper', 'latest'],
    queryFn: loadLatestSweep,
    staleTime: 30_000,
  });

  const latest = data?.latest;
  const autoCloses = latest?.auto_closes ?? [];
  const reviewFlags = latest?.review_flags ?? [];
  const nudges = latest?.nudges ?? [];

  const counts = useMemo(
    () => ({
      auto: autoCloses.length,
      flag: reviewFlags.length,
      nudge: nudges.length,
    }),
    [autoCloses, reviewFlags, nudges],
  );

  return (
    <div className="flex h-full flex-col p-5 gap-5">
      <div className="tk-frame">
        <div className="tk-frame-head">
          <div className="tk-frame-title-wrap">
            <Clock className="tk-frame-title-mark" />
            <div>
              <h2 className="tk-frame-title">
                Auto-close proposals
                <span className="tk-frame-count">
                  ({counts.flag} pending review · {counts.auto} auto-closed)
                </span>
              </h2>
              <div className="tk-frame-sub">
                {latest
                  ? `Sweep ran ${new Date(latest.ts).toLocaleString()} · scanned ${latest.scanned} tasks · cooldown 24h/task`
                  : 'No sweeps yet.'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => navigate({ to: '/tasks' })}
            >
              <ArrowLeft className="h-3 w-3" />
              Back to tasks
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <RefreshCcw className={cn('h-3 w-3', isFetching && 'animate-spin')} />
              Reload sweep-log
            </Button>
          </div>
        </div>

        <div>
          {isLoading && (
            <div className="p-5 text-sm text-muted-foreground">Loading sweep-log…</div>
          )}
          {error instanceof Error && (
            <div className="m-4 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Failed to read sweep-log.jsonl</p>
                <p className="text-xs opacity-80">{error.message}</p>
              </div>
            </div>
          )}

          {latest &&
            counts.auto === 0 &&
            counts.flag === 0 && (
              <div className="p-5 text-sm text-muted-foreground">
                Latest sweep produced no auto-close proposals or review flags.
                {counts.nudge > 0 && ` ${counts.nudge} stale-task nudges below.`}
              </div>
            )}

          {[...autoCloses, ...reviewFlags].map((row) => (
            <SweeperRow
              key={row.full_id}
              row={row}
              onOpenTask={(id) =>
                navigate({ to: '/tasks/$taskId', params: { taskId: id } })
              }
            />
          ))}
        </div>

        <div className="sw-foot">
          <span>
            {latest ? (
              <>
                Last sweep <strong style={{ color: 'var(--fg-muted)' }}>{new Date(latest.ts).toLocaleString()}</strong>
                {' · '}
                {counts.auto} auto-closed · {counts.flag} flagged · {counts.nudge} nudges
              </>
            ) : (
              'No sweep data'
            )}
          </span>
          <span>{data ? `${data.totalSweeps} total sweeps logged` : ''}</span>
        </div>
      </div>

      {/* Stale nudges (separate concern from close proposals) */}
      {nudges.length > 0 && (
        <div className="tk-frame">
          <div className="tk-frame-head">
            <div className="tk-frame-title-wrap">
              <AlertCircle className="tk-frame-title-mark" />
              <div>
                <h2 className="tk-frame-title">
                  Stale-task nudges
                  <span className="tk-frame-count">({nudges.length})</span>
                </h2>
                <div className="tk-frame-sub">
                  Tasks that didn't match an auto-close signal but are aging.
                </div>
              </div>
            </div>
          </div>
          <div>
            {nudges.map((n) => (
              <div
                key={n.full_id}
                className="sw-row"
                onClick={() =>
                  navigate({ to: '/tasks/$taskId', params: { taskId: n.full_id } })
                }
                style={{ cursor: 'pointer' }}
              >
                <div className="lhs">
                  <span
                    className={cn(
                      'rule',
                      n.action === 'escalate' ? 'is-flag' : 'is-auto',
                    )}
                  >
                    {n.action} · {n.age_days}d old
                  </span>
                  <span className="task">{n.title}</span>
                  <span className="id">
                    task · {shortId(n.full_id)} · {n.assigned_to ?? 'unassigned'}
                  </span>
                </div>
                <div className="ev">
                  {n.due_date
                    ? `due ${new Date(n.due_date).toLocaleDateString()}`
                    : 'no due date'}
                </div>
                <div />
                <div className="sw-actions">
                  <Button variant="outline" size="sm" type="button">
                    Open
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SweeperRow({
  row,
  onOpenTask,
}: {
  row: SweepAction;
  onOpenTask: (id: string) => void;
}) {
  const tier = confidenceTier(row.confidence);
  const isAuto = row.action === 'auto_close';
  const evidence =
    typeof row.evidence === 'string'
      ? row.evidence
      : row.evidence
        ? JSON.stringify(row.evidence)
        : `${row.signal_source ?? 'unknown signal'} · confidence ${(row.confidence ?? 0).toFixed(2)}`;

  return (
    <div className="sw-row">
      <div className="lhs">
        <span className={cn('rule', isAuto ? 'is-auto' : 'is-flag')}>
          {row.signal_source ?? row.action} ·{' '}
          {row.confidence ? row.confidence.toFixed(2) : '—'}
        </span>
        <span className="task">{row.title}</span>
        <span className="id">
          task · {shortId(row.full_id)} · {relativeAgo(new Date().toISOString())}
        </span>
      </div>
      <div className="ev">{evidence}</div>
      <div className={cn('sw-conf', `lvl-${tier}`)}>
        <div className="bar">
          <span />
          <span />
          <span />
          <span />
        </div>
        <span className="label">
          {isAuto ? 'auto' : 'flag'} · {row.confidence?.toFixed(2) ?? '—'}
        </span>
      </div>
      <div className="sw-actions">
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => onOpenTask(row.full_id)}
        >
          Open
        </Button>
        <Button size="sm" type="button" disabled title="Approve action — not wired">
          <Check className="h-3 w-3" />
          {isAuto ? 'Confirm' : 'Close'}
        </Button>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/sweeper')({
  component: SweeperPage,
});

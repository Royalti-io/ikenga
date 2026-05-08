import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Inbox,
  ShieldCheck,
  Send,
  CheckSquare,
  AlertTriangle,
  Calendar as CalendarIcon,
  Activity,
  type LucideIcon,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';

interface CardProps {
  title: string;
  Icon: LucideIcon;
  to: string;
  count: number | null;
  isLoading: boolean;
  caption?: string;
  tone?: 'neutral' | 'warn' | 'urgent';
}

function Card({ title, Icon, to, count, isLoading, caption, tone = 'neutral' }: CardProps) {
  const toneClass =
    tone === 'urgent'
      ? 'text-red-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : 'text-foreground';
  return (
    <Link
      to={to}
      className="group flex flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/40 hover:bg-accent/30"
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      <div className={cn('mt-2 text-3xl font-bold tabular-nums', toneClass)}>
        {isLoading ? <span className="text-muted-foreground">—</span> : (count ?? 0)}
      </div>
      {caption && <p className="mt-1 text-xs text-muted-foreground">{caption}</p>}
    </Link>
  );
}

function inboxQuery() {
  return {
    queryKey: ['home', 'inbox-count'] as const,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('email_messages')
        .select('id', { count: 'exact', head: true })
        .in('triage_category', ['urgent', 'action_needed'])
        .is('processed_at', null);
      if (error) throw error;
      return count ?? 0;
    },
  };
}

function approvalsQuery() {
  return {
    queryKey: ['home', 'approvals-count'] as const,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .eq('execution_mode', 'approval_required')
        .not('task_result', 'is', null);
      if (error) throw error;
      return count ?? 0;
    },
  };
}

function outboxPendingQuery() {
  return {
    queryKey: ['home', 'outbox-pending-count'] as const,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('email_drafts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_review');
      if (error) throw error;
      return count ?? 0;
    },
  };
}

function overdueTasksQuery() {
  return {
    queryKey: ['home', 'overdue-tasks'] as const,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tasks')
        .select('id, title, priority, due_date')
        .eq('status', 'pending')
        .not('due_date', 'is', null)
        .lt('due_date', new Date().toISOString())
        .order('due_date', { ascending: true })
        .limit(3);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        title: string;
        priority: string | null;
        due_date: string;
      }>;
    },
  };
}

function cronFailuresQuery() {
  return {
    queryKey: ['home', 'cron-failures'] as const,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('agent_runs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'failed')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      if (error) throw error;
      return count ?? 0;
    },
  };
}

function todayCalendarQuery() {
  return {
    queryKey: ['home', 'today-calendar'] as const,
    queryFn: async () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      const { data, error } = await supabase
        .from('calendar_events')
        .select('id, title, start_time, end_time')
        .gte('start_time', start.toISOString())
        .lt('start_time', end.toISOString())
        .order('start_time', { ascending: true })
        .limit(5);
      if (error) {
        // Calendar table is optional in some environments — degrade gracefully.
        return [] as Array<{ id: string; title: string; start_time: string }>;
      }
      return (data ?? []) as Array<{
        id: string;
        title: string;
        start_time: string;
        end_time?: string | null;
      }>;
    },
  };
}

function HomePage() {
  const inbox = useQuery(inboxQuery());
  const approvals = useQuery(approvalsQuery());
  const outboxPending = useQuery(outboxPendingQuery());
  const overdue = useQuery(overdueTasksQuery());
  const cronFailures = useQuery(cronFailuresQuery());
  const calendar = useQuery(todayCalendarQuery());

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold">Home</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-6 space-y-6">
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            At a glance
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <Card
              title="Inbox"
              Icon={Inbox}
              to="/mail/inbox"
              count={inbox.data ?? null}
              isLoading={inbox.isLoading}
              caption="Urgent + action needed"
              tone={(inbox.data ?? 0) > 0 ? 'urgent' : 'neutral'}
            />
            <Card
              title="Approvals"
              Icon={ShieldCheck}
              to="/pkg/com.ikenga.exec/approvals"
              count={approvals.data ?? null}
              isLoading={approvals.isLoading}
              caption="Tasks awaiting approval"
              tone={(approvals.data ?? 0) > 0 ? 'warn' : 'neutral'}
            />
            <Card
              title="Outbox"
              Icon={Send}
              to="/outbox/email"
              count={outboxPending.data ?? null}
              isLoading={outboxPending.isLoading}
              caption="Pending review"
              tone={(outboxPending.data ?? 0) > 0 ? 'warn' : 'neutral'}
            />
            <Card
              title="Cron failures"
              Icon={Activity}
              to="/pkg/com.ikenga.work/cron"
              count={cronFailures.data ?? null}
              isLoading={cronFailures.isLoading}
              caption="Last 24h"
              tone={(cronFailures.data ?? 0) > 0 ? 'urgent' : 'neutral'}
            />
            <Card
              title="Today"
              Icon={CalendarIcon}
              to="/calendar"
              count={calendar.data?.length ?? null}
              isLoading={calendar.isLoading}
              caption="Calendar events"
            />
          </div>
        </section>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Overdue tasks
            </h2>
            <div className="rounded-lg border border-border">
              {overdue.isLoading ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
              ) : overdue.data && overdue.data.length > 0 ? (
                <ul className="divide-y divide-border">
                  {overdue.data.map((t) => {
                    const days = Math.floor(
                      (Date.now() - new Date(t.due_date).getTime()) / (1000 * 60 * 60 * 24),
                    );
                    return (
                      <li key={t.id}>
                        <Link
                          to="/tasks/$taskId"
                          params={{ taskId: t.id }}
                          className="flex items-start gap-3 px-4 py-3 text-sm hover:bg-accent/30"
                        >
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{t.title}</div>
                            <div className="text-xs text-muted-foreground">
                              {days === 0
                                ? 'due today'
                                : days === 1
                                  ? 'overdue 1 day'
                                  : `overdue ${days} days`}
                              {t.priority && (
                                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                                  {t.priority}
                                </span>
                              )}
                            </div>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="px-4 py-3 text-sm text-muted-foreground">Nothing overdue.</div>
              )}
            </div>
            <Link
              to="/tasks"
              className="mt-2 inline-block text-xs text-muted-foreground hover:underline"
            >
              All tasks →
            </Link>
          </div>

          <div>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Today's calendar
            </h2>
            <div className="rounded-lg border border-border">
              {calendar.isLoading ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
              ) : calendar.data && calendar.data.length > 0 ? (
                <ul className="divide-y divide-border">
                  {calendar.data.map((ev) => (
                    <li
                      key={ev.id}
                      className="flex items-start gap-3 px-4 py-3 text-sm"
                    >
                      <CalendarIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{ev.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(ev.start_time).toLocaleTimeString('en-US', {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-4 py-3 text-sm text-muted-foreground">
                  Nothing scheduled.
                </div>
              )}
            </div>
            <Link
              to="/calendar"
              className="mt-2 inline-block text-xs text-muted-foreground hover:underline"
            >
              Full calendar →
            </Link>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Quick links
          </h2>
          <div className="flex flex-wrap gap-2">
            <QuickLink to="/mail/triage" Icon={Inbox} label="Triage" />
            <QuickLink to="/mail/drafts" Icon={CheckSquare} label="Reply Drafts" />
            <QuickLink to="/outbox/sent" Icon={Send} label="Outbox · Sent" />
            <QuickLink to="/pkg/com.ikenga.finance/finance" Icon={Activity} label="Finance" />
            <QuickLink to="/sessions" Icon={Activity} label="Sessions" />
          </div>
        </section>
      </div>
    </div>
  );
}

function QuickLink({ to, Icon, label }: { to: string; Icon: LucideIcon; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent"
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      {label}
    </Link>
  );
}

export const Route = createFileRoute('/')({
  component: HomePage,
});

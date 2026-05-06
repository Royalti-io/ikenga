import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Briefcase,
  AlertCircle,
  Loader2,
  TrendingUp,
  Wallet,
  Users,
  Target,
  Activity,
  ShieldAlert,
  CheckSquare,
  type LucideIcon,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { cn } from '@/components/ui/utils';

type HealthStatus = 'healthy' | 'warning' | 'critical';

interface DomainHealthItem {
  domain: string;
  status: HealthStatus;
  keyMetric: string;
  notes?: string;
  to?: string;
  Icon: LucideIcon;
}

const healthColor: Record<HealthStatus, string> = {
  healthy: 'border-green-200 bg-green-50',
  warning: 'border-amber-200 bg-amber-50',
  critical: 'border-red-200 bg-red-50',
};

const healthDot: Record<HealthStatus, string> = {
  healthy: 'bg-green-500',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
};

function formatUsd(n: number): string {
  if (!n) return '$0';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

function ExecutivePage() {
  const initiativesQ = useQuery({
    queryKey: ['exec', 'initiatives'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('strategic_initiatives')
        .select('id, status, progress_pct')
        .neq('status', 'cancelled');
      if (error) throw error;
      return data ?? [];
    },
  });

  const tasksQ = useQuery({
    queryKey: ['exec', 'tasks-summary'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tasks')
        .select('id, status, priority, due_date');
      if (error) throw error;
      return data ?? [];
    },
  });

  const risksQ = useQuery({
    queryKey: ['exec', 'risks'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('risk_register')
        .select('id, severity, status')
        .neq('status', 'Closed');
      if (error) throw error;
      return data ?? [];
    },
  });

  const partnershipsQ = useQuery({
    queryKey: ['exec', 'partnerships'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('partnership_deals')
        .select('id, stage, revenue_year1_usd, health_score')
        .neq('stage', 'inactive');
      if (error) throw error;
      return data ?? [];
    },
  });

  const salesQ = useQuery({
    queryKey: ['exec', 'sales'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sales_deals')
        .select('id, stage, value');
      if (error) throw error;
      return data ?? [];
    },
  });

  const runsQ = useQuery({
    queryKey: ['exec', 'agent-runs-24h'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_runs')
        .select('id, status')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      if (error) throw error;
      return data ?? [];
    },
  });

  const isLoading =
    initiativesQ.isLoading ||
    tasksQ.isLoading ||
    risksQ.isLoading ||
    partnershipsQ.isLoading ||
    salesQ.isLoading ||
    runsQ.isLoading;

  const firstError =
    initiativesQ.error ||
    tasksQ.error ||
    risksQ.error ||
    partnershipsQ.error ||
    salesQ.error ||
    runsQ.error;

  const initiatives = initiativesQ.data ?? [];
  const activeInitiatives = initiatives.filter((i) => i.status === 'active');
  const initiativeProgress =
    activeInitiatives.length > 0
      ? Math.round(
          activeInitiatives.reduce((s, i) => s + (i.progress_pct ?? 0), 0) /
            activeInitiatives.length,
        )
      : 0;

  const tasks = tasksQ.data ?? [];
  const overdueTasks = tasks.filter(
    (t) => t.status === 'pending' && t.due_date && new Date(t.due_date) < new Date(),
  ).length;
  const urgentTasks = tasks.filter(
    (t) => t.status === 'pending' && t.priority === 'urgent',
  ).length;

  const risks = risksQ.data ?? [];
  const highRisks = risks.filter((r) => r.severity === 'High' && r.status !== 'Mitigated').length;

  const partnerships = partnershipsQ.data ?? [];
  const partnershipPipeline = partnerships.reduce(
    (s, p) => s + (p.revenue_year1_usd ?? 0),
    0,
  );

  const salesDeals = salesQ.data ?? [];
  const openSales = salesDeals.filter(
    (d) => d.stage !== 'closed-won' && d.stage !== 'closed-lost',
  );
  const salesPipeline = openSales.reduce((s, d) => s + (d.value ?? 0), 0);

  const runs = runsQ.data ?? [];
  const failedRuns = runs.filter((r) => r.status === 'failed').length;
  const totalRuns = runs.length;

  // Synthesize domain health
  const domains: DomainHealthItem[] = [
    {
      domain: 'Finance',
      Icon: Wallet,
      status: 'warning',
      keyMetric: 'See Finance tab',
      notes: 'Runway/burn aggregation not yet wired into the desktop',
      to: '/finance',
    },
    {
      domain: 'Sales',
      Icon: TrendingUp,
      status: openSales.length === 0 ? 'critical' : openSales.length < 3 ? 'warning' : 'healthy',
      keyMetric: `${formatUsd(salesPipeline)} pipeline · ${openSales.length} open`,
      to: '/sales',
    },
    {
      domain: 'Partnerships',
      Icon: Users,
      status:
        partnerships.length === 0 ? 'warning' : partnerships.length < 3 ? 'warning' : 'healthy',
      keyMetric: `${formatUsd(partnershipPipeline)} Y1 · ${partnerships.length} active`,
      to: '/partnerships',
    },
    {
      domain: 'Strategy',
      Icon: Target,
      status: highRisks > 2 ? 'critical' : highRisks > 0 ? 'warning' : 'healthy',
      keyMetric: `${activeInitiatives.length} active · ${initiativeProgress}% avg`,
      notes: highRisks > 0 ? `${highRisks} high-severity risks` : undefined,
      to: '/strategy',
    },
    {
      domain: 'Ops',
      Icon: Activity,
      status: failedRuns > 5 ? 'critical' : failedRuns > 0 ? 'warning' : 'healthy',
      keyMetric: `${failedRuns}/${totalRuns} failed runs (24h)`,
      to: '/cron',
    },
    {
      domain: 'Tasks',
      Icon: CheckSquare,
      status: urgentTasks + overdueTasks > 5 ? 'critical' : urgentTasks + overdueTasks > 0 ? 'warning' : 'healthy',
      keyMetric: `${overdueTasks} overdue · ${urgentTasks} urgent`,
      to: '/tasks',
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Executive dashboard</h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          CEO scorecard — cross-functional health snapshot. Quarterly metrics + board report
          generator pending.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {firstError instanceof Error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load some scorecard data</p>
              <p className="text-xs opacity-80">{firstError.message}</p>
            </div>
          </div>
        )}

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Cross-functional health
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {domains.map((d) => {
              const Icon = d.Icon;
              const card = (
                <div
                  className={cn(
                    'flex h-full flex-col rounded-lg border p-4 transition-colors',
                    healthColor[d.status],
                    d.to && 'hover:bg-accent/40 cursor-pointer',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn('h-2 w-2 rounded-full', healthDot[d.status])}
                      aria-hidden
                    />
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{d.domain}</span>
                  </div>
                  <p className="mt-2 text-sm tabular-nums">{d.keyMetric}</p>
                  {d.notes && (
                    <p className="mt-1 text-xs text-muted-foreground">{d.notes}</p>
                  )}
                </div>
              );
              return d.to ? (
                <Link key={d.domain} to={d.to}>
                  {card}
                </Link>
              ) : (
                <div key={d.domain}>{card}</div>
              );
            })}
          </div>
        </section>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Strategic initiatives
            </h2>
            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              <Row label="Active" value={activeInitiatives.length} />
              <Row label="Avg progress" value={`${initiativeProgress}%`} />
              <Row label="Total (excl. cancelled)" value={initiatives.length} />
              <Link
                to="/strategy"
                className="mt-2 inline-block text-xs text-muted-foreground hover:underline"
              >
                Strategy detail →
              </Link>
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Risk register
            </h2>
            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              <Row
                label="High severity"
                value={highRisks}
                tone={highRisks > 0 ? 'urgent' : 'neutral'}
                Icon={ShieldAlert}
              />
              <Row label="Total open" value={risks.length} />
              <Link
                to="/strategy"
                className="mt-2 inline-block text-xs text-muted-foreground hover:underline"
              >
                Risk register →
              </Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone = 'neutral',
  Icon,
}: {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'urgent' | 'warn';
  Icon?: LucideIcon;
}) {
  const toneClass =
    tone === 'urgent' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-foreground';
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="flex items-center gap-2 text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </span>
      <span className={cn('font-bold tabular-nums', toneClass)}>{value}</span>
    </div>
  );
}

export const Route = createFileRoute('/executive/')({
  component: ExecutivePage,
});

import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';

import { overviewQuery } from '@/lib/queries/finance/overview';
import { useEntityStore } from '@/lib/finance/entity-store';
import type { CashFlowMonthRow } from '@/lib/finance/overview';
import { fmtUsd, fmtUsdSigned } from '@/lib/finance/currency';
import { cn } from '@/components/ui/utils';

function CashFlow6moChart({ data }: { data: CashFlowMonthRow[] }) {
  if (!data.length) {
    return <div className="text-sm text-muted-foreground">No cash flow data.</div>;
  }
  const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.net_usd)));
  const W = 720;
  const H = 160;
  const barW = 60;
  const gap = (W - 80 - data.length * barW) / Math.max(1, data.length - 1);
  const baseY = H / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H + 20}`} className="w-full" preserveAspectRatio="none">
      <line x1="40" y1={baseY} x2={W - 20} y2={baseY} stroke="currentColor" strokeOpacity={0.2} strokeDasharray="3,3" />
      <text x="6" y={baseY + 4} fontSize="9" fontFamily="ui-monospace, monospace" fill="currentColor" fillOpacity={0.6}>
        0
      </text>
      {data.map((d, i) => {
        const h = (Math.abs(d.net_usd) / maxAbs) * (H / 2 - 10);
        const x = 80 + i * (barW + gap);
        const y = d.net_usd >= 0 ? baseY - h : baseY;
        const fill = d.net_usd >= 0 ? '#0d9488' : '#a04030';
        const fillOpacity = d.net_usd >= 0 ? 1 : 0.7;
        const [, mm] = d.month.split('-');
        const label = new Date(2000, Number(mm) - 1, 1).toLocaleString('en-US', { month: 'short' });
        return (
          <g key={d.month}>
            <rect x={x} y={y} width={barW} height={h} fill={fill} fillOpacity={fillOpacity} />
            <text
              x={x + barW / 2}
              y={H + 14}
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fill="currentColor"
              fillOpacity={0.6}
              textAnchor="middle"
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 120;
  const H = 28;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - ((v - min) / range) * H;
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-7 w-full opacity-70">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function StatCard({
  label,
  value,
  sub,
  spark,
  invert,
}: {
  label: string;
  value: string;
  sub?: string | null;
  spark?: number[];
  invert?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && (
        <div
          className={cn(
            'mt-0.5 text-xs',
            sub.startsWith('-') || sub.startsWith('−')
              ? invert
                ? 'text-emerald-700'
                : 'text-red-700'
              : invert
                ? 'text-red-700'
                : 'text-emerald-700',
          )}
        >
          {sub}
        </div>
      )}
      {spark && spark.length > 1 && <Sparkline values={spark} />}
    </div>
  );
}

function FinanceOverviewPage() {
  const entity = useEntityStore((s) => s.entity);
  const { data, isLoading, error } = useQuery(overviewQuery(entity));

  return (
    <div className="px-6 py-4">
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {error instanceof Error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Failed to load finance overview</p>
            <p className="text-xs opacity-80">{error.message}</p>
          </div>
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {data.alerts.length > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900/50 dark:bg-yellow-950/30">
              <AlertTriangle className="h-5 w-5 flex-shrink-0 text-yellow-600" />
              <div className="flex-1 space-y-1">
                {data.alerts.slice(0, 3).map((a) => (
                  <Link
                    key={a.id}
                    to={a.href}
                    className="block text-sm text-yellow-900 hover:underline dark:text-yellow-100"
                  >
                    {a.message}
                  </Link>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Cash (USD)"
              value={fmtUsd(data.kpis.cash_usd.value)}
              sub={
                data.kpis.cash_usd.delta_pct == null
                  ? null
                  : `${data.kpis.cash_usd.delta_pct > 0 ? '+' : ''}${data.kpis.cash_usd.delta_pct}% vs prior mo`
              }
              spark={data.kpis.cash_usd.spark}
            />
            <StatCard
              label="Burn / mo"
              value={fmtUsd(data.kpis.burn_usd_per_mo.value)}
              sub={
                data.kpis.burn_usd_per_mo.delta_pct == null
                  ? null
                  : `${data.kpis.burn_usd_per_mo.delta_pct > 0 ? '+' : ''}${data.kpis.burn_usd_per_mo.delta_pct}% vs avg`
              }
              spark={data.kpis.burn_usd_per_mo.spark}
              invert
            />
            <StatCard
              label="Runway"
              value={`${data.kpis.runway_months.value.toFixed(1)} mo`}
              sub="@ current burn"
              spark={data.kpis.cash_usd.spark}
            />
            <StatCard
              label="A/R Outstanding"
              value={fmtUsd(data.kpis.ar_outstanding.value)}
              sub={
                data.kpis.ar_outstanding.overdue_count > 0
                  ? `${data.kpis.ar_outstanding.overdue_count} overdue`
                  : 'none overdue'
              }
              invert
            />
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-base font-semibold">Cash Flow — Last 6 months</h2>
              <span className="text-xs text-muted-foreground">net · monthly · USD</span>
            </div>
            <CashFlow6moChart data={data.cash_flow_6mo} />
          </div>

          <div>
            <h2 className="mb-3 text-base font-semibold">Cash Position by Entity</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.cash_by_account.map((row) => (
                <div
                  key={`${row.entity}-${row.currency}`}
                  className="rounded-lg border border-border bg-card p-3"
                >
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    {row.entity} · {row.currency}
                  </div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    {fmtUsd(row.balance_usd)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.balance_native.toLocaleString()} {row.currency} · {row.account_count}{' '}
                    account{row.account_count === 1 ? '' : 's'}
                  </div>
                </div>
              ))}
              {data.cash_by_account.length === 0 && (
                <div className="col-span-full rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  No active accounts.
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Recent Activity</h2>
              <Link
                to="/finance/transactions"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Date</th>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_activity.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                        {r.date}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="max-w-[28rem] truncate" title={r.desc}>
                          {r.desc}
                        </div>
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2 align-top text-right tabular-nums',
                          r.amount_usd < 0 ? 'text-red-700' : 'text-emerald-700',
                        )}
                      >
                        {fmtUsdSigned(r.amount_usd)}
                      </td>
                    </tr>
                  ))}
                  {data.recent_activity.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-3 py-6 text-center text-xs text-muted-foreground">
                        No activity in the last 7 days.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/finance/')({
  component: FinanceOverviewPage,
});

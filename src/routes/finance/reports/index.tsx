import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';

import {
  defaultQuarter,
  periodOptions,
  pnlQuery,
  previousQuarter,
} from '@/lib/queries/finance/reports';
import type { PnlResponse } from '@/lib/queries/finance/reports';
import { useEntityStore } from '@/lib/finance/entity-store';
import { fmtUsdSigned } from '@/lib/finance/currency';
import { cn } from '@/components/ui/utils';

const TABS = [
  { key: 'pnl', label: 'P&L' },
  { key: 'budget', label: 'Budget vs Actual' },
  { key: 'cashflow', label: 'Cash Flow' },
  { key: 'burn', label: 'Burn Analytics' },
  { key: 'custom', label: 'Custom' },
] as const;
type ReportTab = (typeof TABS)[number]['key'];

function deltaClass(pct: number | null, invert?: boolean): string {
  if (pct == null) return 'text-muted-foreground';
  const positive = pct >= 0;
  if (invert) return positive ? 'text-red-700' : 'text-emerald-700';
  return positive ? 'text-emerald-700' : 'text-red-700';
}

function StatCard({
  label,
  value,
  delta,
  invert,
}: {
  label: string;
  value: string;
  delta: number | null;
  invert?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className={cn('mt-0.5 text-xs', deltaClass(delta, invert))}>
        {delta != null ? `${delta > 0 ? '+' : ''}${delta}% vs prior period` : ' '}
      </div>
    </div>
  );
}

function PnlTable({ data }: { data: PnlResponse }) {
  if (!data.rows.length) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
        No P&L data for this period.
      </div>
    );
  }
  let lastGroup: string | null = null;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Category</th>
            {data.columns.map((c) => (
              <th key={c} className="px-3 py-2 text-right font-medium tabular-nums">
                {c}
              </th>
            ))}
            <th className="px-3 py-2 text-right font-medium">Total</th>
            <th className="px-3 py-2 text-right font-medium">Δ</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => {
            const groupChange = r.group !== lastGroup;
            lastGroup = r.group;
            return (
              <>
                {groupChange && (
                  <tr
                    key={`g-${r.group}`}
                    className="border-t border-border bg-muted/20 text-xs uppercase tracking-wider text-muted-foreground"
                  >
                    <td colSpan={data.columns.length + 3} className="px-3 py-1">
                      {r.group}
                    </td>
                  </tr>
                )}
                <tr key={r.category} className="border-t border-border">
                  <td className="px-3 py-2 align-top">{r.category}</td>
                  {r.values.map((v, i) => (
                    <td
                      key={i}
                      className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                    >
                      {v === 0 ? '·' : fmtUsdSigned(v)}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {fmtUsdSigned(r.total)}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right text-xs tabular-nums',
                      deltaClass(r.delta_pct, r.group !== 'Revenue'),
                    )}
                  >
                    {r.delta_pct == null ? '—' : `${r.delta_pct > 0 ? '+' : ''}${r.delta_pct}%`}
                  </td>
                </tr>
              </>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-border bg-muted/30 font-semibold">
            <td className="px-3 py-2">Net</td>
            {data.net_per_column.map((v, i) => (
              <td key={i} className="px-3 py-2 text-right tabular-nums">
                {fmtUsdSigned(v)}
              </td>
            ))}
            <td className="px-3 py-2 text-right tabular-nums">
              {fmtUsdSigned(data.summary.net_usd)}
            </td>
            <td className={cn('px-3 py-2 text-right', deltaClass(data.summary.delta_qoq_pct.net))}>
              {data.summary.delta_qoq_pct.net == null
                ? '—'
                : `${data.summary.delta_qoq_pct.net > 0 ? '+' : ''}${data.summary.delta_qoq_pct.net}%`}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function DeferredTab({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
      <p className="mt-3 text-xs text-muted-foreground">
        Deferred — coming after the consolidated v1 ships.
      </p>
    </div>
  );
}

function ReportsPage() {
  const entity = useEntityStore((s) => s.entity);
  const [tab, setTab] = useState<ReportTab>('pnl');
  const [period, setPeriod] = useState<string>(defaultQuarter());
  const [compareTo, setCompareTo] = useState<string>('');
  const [granularity, setGranularity] = useState<string>('monthly');

  const compare = compareTo || previousQuarter(period);
  const { data, isLoading, error } = useQuery({
    ...pnlQuery({ entity, period, compare_to: compare }),
    enabled: tab === 'pnl',
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-border px-6">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'border-b-2 px-1 py-3 text-sm font-medium transition-colors',
              tab === t.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3 text-xs">
        <label className="text-muted-foreground">Period</label>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1"
        >
          {periodOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="ml-3 text-muted-foreground">Compare to</label>
        <select
          value={compare}
          onChange={(e) => setCompareTo(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1"
        >
          {periodOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="ml-3 text-muted-foreground">Granularity</label>
        <select
          value={granularity}
          onChange={(e) => setGranularity(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1"
        >
          <option value="monthly">Monthly</option>
          <option value="weekly">Weekly</option>
          <option value="daily">Daily</option>
          <option value="quarterly">Quarterly</option>
        </select>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {tab === 'pnl' && (
          <>
            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading P&L…
              </div>
            )}

            {error instanceof Error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>{error.message}</div>
              </div>
            )}

            {data && (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <StatCard
                    label="Revenue"
                    value={fmtUsdSigned(data.summary.revenue_usd)}
                    delta={data.summary.delta_qoq_pct.revenue}
                  />
                  <StatCard
                    label="COGS"
                    value={fmtUsdSigned(data.summary.cogs_usd)}
                    delta={data.summary.delta_qoq_pct.cogs}
                    invert
                  />
                  <StatCard
                    label="OpEx"
                    value={fmtUsdSigned(data.summary.opex_usd)}
                    delta={data.summary.delta_qoq_pct.opex}
                    invert
                  />
                  <StatCard
                    label="Net"
                    value={fmtUsdSigned(data.summary.net_usd)}
                    delta={data.summary.delta_qoq_pct.net}
                  />
                </div>

                <div className="text-xs text-muted-foreground">
                  {data.period.label}
                  {data.compare_to && ` vs ${data.compare_to.label}`}
                </div>

                <PnlTable data={data} />
              </>
            )}
          </>
        )}

        {tab === 'budget' && (
          <DeferredTab
            title="Budget vs Actual"
            desc="Variance bars + spending tracking. Existing screen kept while we wire the consolidated view."
          />
        )}
        {tab === 'cashflow' && (
          <DeferredTab
            title="Cash Flow"
            desc="12-month inflow/outflow trends, entity overlay, and waterfall."
          />
        )}
        {tab === 'burn' && (
          <DeferredTab
            title="Burn Analytics"
            desc="Runway gauge with conservative/likely/optimistic scenarios."
          />
        )}
        {tab === 'custom' && (
          <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
            <h3 className="text-base font-semibold">Custom reports</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              Build a custom report with the categories, periods, and entities you care about.
              Coming after the consolidated v1 ships.
            </p>
            <Link
              to="/finance"
              className="mt-4 inline-flex rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Back to overview
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/finance/reports/')({
  component: ReportsPage,
});

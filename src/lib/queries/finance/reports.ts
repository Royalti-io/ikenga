import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';
import { convertToUsd, getLatestRates } from '@/lib/finance/currency';
import type { EntityFilter } from '@/lib/finance/overview';

const ENTITY_DB: Record<Exclude<EntityFilter, 'all'>, string> = {
  royalti: 'Royalti',
  dixtrit: 'Dixtrit',
  personal: 'Personal',
};

export interface PnlPeriod {
  label: string;
  from: string;
  to: string;
}

export interface PnlRow {
  category: string;
  group: 'Revenue' | 'COGS' | 'OpEx';
  values: number[];
  total: number;
  compare_total: number | null;
  delta_pct: number | null;
}

export interface PnlResponse {
  period: PnlPeriod;
  compare_to: PnlPeriod | null;
  columns: string[];
  summary: {
    revenue_usd: number;
    cogs_usd: number;
    opex_usd: number;
    net_usd: number;
    delta_qoq_pct: {
      revenue: number | null;
      cogs: number | null;
      opex: number | null;
      net: number | null;
    };
  };
  rows: PnlRow[];
  net_per_column: number[];
}

export function quarterToRange(period: string): PnlPeriod {
  const m = period.match(/^(\d{4})-Q([1-4])$/);
  if (m) {
    const year = Number(m[1]);
    const q = Number(m[2]);
    const startMonth = (q - 1) * 3;
    const from = `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
    const endDate = new Date(year, startMonth + 3, 0);
    const to = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(
      endDate.getDate(),
    ).padStart(2, '0')}`;
    return { label: `Q${q} ${year}`, from, to };
  }
  const mm = period.match(/^(\d{4})-(\d{2})$/);
  if (mm) {
    const year = Number(mm[1]);
    const month = Number(mm[2]);
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0);
    const to = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(
      endDate.getDate(),
    ).padStart(2, '0')}`;
    return {
      label: `${endDate.toLocaleString('en-US', { month: 'long' })} ${year}`,
      from,
      to,
    };
  }
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return quarterToRange(`${now.getFullYear()}-Q${q}`);
}

export function previousPeriod(p: PnlPeriod): PnlPeriod {
  const fromDate = new Date(p.from + 'T00:00:00Z');
  const toDate = new Date(p.to + 'T00:00:00Z');
  const lengthDays =
    Math.round((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const newTo = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
  const newFrom = new Date(newTo.getTime() - (lengthDays - 1) * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`;
  return { label: 'Previous', from: fmt(newFrom), to: fmt(newTo) };
}

function classify(
  category: string | null,
  type: string,
): { group: PnlRow['group']; bucket: string } {
  const c = (category ?? '').toLowerCase();
  if (type === 'income') {
    if (c.includes('paystack')) return { group: 'Revenue', bucket: 'Paystack splits' };
    if (c.includes('subscription') || c.includes('saas'))
      return { group: 'Revenue', bucket: 'SaaS subscriptions' };
    return { group: 'Revenue', bucket: category || 'Other revenue' };
  }
  if (type === 'expense') {
    if (c.includes('cloud') || c.includes('infrastructure') || c.includes('hosting'))
      return { group: 'COGS', bucket: 'Cloud / infra' };
    if (
      c.includes('payment') ||
      c.includes('processing') ||
      c.includes('stripe') ||
      c.includes('paystack')
    )
      return { group: 'COGS', bucket: 'Payment processing' };
    if (c.includes('payroll') || c.includes('salary') || c.includes('contractor'))
      return { group: 'OpEx', bucket: 'Payroll' };
    if (c.includes('marketing') || c.includes('advertising'))
      return { group: 'OpEx', bucket: 'Marketing' };
    if (c.includes('legal') || c.includes('accounting') || c.includes('compliance'))
      return { group: 'OpEx', bucket: 'Legal / accounting' };
    if (c.includes('saas') || c.includes('tool') || c.includes('software'))
      return { group: 'OpEx', bucket: 'SaaS tooling' };
    return { group: 'OpEx', bucket: category || 'Other expense' };
  }
  return { group: 'OpEx', bucket: category || 'Other' };
}

function monthCols(p: PnlPeriod): string[] {
  const cols: string[] = [];
  const start = new Date(p.from + 'T00:00:00Z');
  const end = new Date(p.to + 'T00:00:00Z');
  const cur = new Date(start.getUTCFullYear(), start.getUTCMonth(), 1);
  while (cur <= end) {
    cols.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return cols;
}

export interface PnlParams {
  entity: EntityFilter;
  period: string;
  compare_to: string;
}

export async function getPnl(params: PnlParams): Promise<PnlResponse> {
  const period = quarterToRange(params.period);
  const compare = params.compare_to
    ? quarterToRange(params.compare_to)
    : (() => {
        return previousPeriod(period);
      })();
  const dbEntity = params.entity === 'all' ? null : ENTITY_DB[params.entity];
  const rates = await getLatestRates(supabase);

  const fetchRows = async (p: PnlPeriod) => {
    let q = supabase
      .from('transaction_ledger')
      .select('txn_date, amount, amount_usd, currency, category, type')
      .gte('txn_date', p.from)
      .lte('txn_date', p.to);
    if (dbEntity) q = q.eq('entity', dbEntity);
    const { data } = await q;
    return data ?? [];
  };

  const [main, compareData] = await Promise.all([fetchRows(period), fetchRows(compare)]);

  const cols = monthCols(period);
  const colIdx = (date: string) => cols.indexOf(date.substring(0, 7));

  type Bucket = { group: PnlRow['group']; values: number[]; total: number };
  const buckets = new Map<string, Bucket>();
  const ensure = (label: string, group: PnlRow['group']): Bucket => {
    let b = buckets.get(label);
    if (!b) {
      b = { group, values: cols.map(() => 0), total: 0 };
      buckets.set(label, b);
    }
    return b;
  };

  const compareTotals = new Map<string, number>();
  for (const r of compareData) {
    const usd =
      r.amount_usd != null
        ? Math.abs(r.amount_usd)
        : convertToUsd(Math.abs(r.amount), r.currency, rates);
    const { bucket } = classify(r.category, r.type);
    const signed = r.type === 'income' ? usd : r.type === 'expense' ? -usd : 0;
    compareTotals.set(bucket, (compareTotals.get(bucket) ?? 0) + signed);
  }

  let summaryRev = 0;
  let summaryCogs = 0;
  let summaryOpex = 0;
  for (const r of main) {
    const usd =
      r.amount_usd != null
        ? Math.abs(r.amount_usd)
        : convertToUsd(Math.abs(r.amount), r.currency, rates);
    const { group, bucket } = classify(r.category, r.type);
    const signed = r.type === 'income' ? usd : r.type === 'expense' ? -usd : 0;
    const idx = colIdx(r.txn_date);
    if (idx < 0) continue;
    const b = ensure(bucket, group);
    b.values[idx] += signed;
    b.total += signed;
    if (group === 'Revenue') summaryRev += signed;
    else if (group === 'COGS') summaryCogs += signed;
    else if (group === 'OpEx') summaryOpex += signed;
  }

  let cmpRev = 0;
  let cmpCogs = 0;
  let cmpOpex = 0;
  for (const r of compareData) {
    const usd =
      r.amount_usd != null
        ? Math.abs(r.amount_usd)
        : convertToUsd(Math.abs(r.amount), r.currency, rates);
    const { group } = classify(r.category, r.type);
    const signed = r.type === 'income' ? usd : r.type === 'expense' ? -usd : 0;
    if (group === 'Revenue') cmpRev += signed;
    else if (group === 'COGS') cmpCogs += signed;
    else if (group === 'OpEx') cmpOpex += signed;
  }

  const pct = (curr: number, prev: number): number | null => {
    if (prev === 0) return null;
    return Math.round(((curr - prev) / Math.abs(prev)) * 100);
  };

  const groupOrder: PnlRow['group'][] = ['Revenue', 'COGS', 'OpEx'];
  const rows: PnlRow[] = Array.from(buckets.entries())
    .map(([category, b]) => {
      const cmp = compareTotals.get(category) ?? null;
      return {
        category,
        group: b.group,
        values: b.values.map((v) => Math.round(v)),
        total: Math.round(b.total),
        compare_total: cmp == null ? null : Math.round(cmp),
        delta_pct: cmp == null ? null : pct(b.total, cmp),
      };
    })
    .sort((a, b) => {
      if (a.group !== b.group) return groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
      return Math.abs(b.total) - Math.abs(a.total);
    });

  const netPerCol = cols.map((_, i) =>
    Math.round(rows.reduce((s, r) => s + r.values[i], 0)),
  );

  return {
    period,
    compare_to: compare,
    columns: cols,
    summary: {
      revenue_usd: Math.round(summaryRev),
      cogs_usd: Math.round(summaryCogs),
      opex_usd: Math.round(summaryOpex),
      net_usd: Math.round(summaryRev + summaryCogs + summaryOpex),
      delta_qoq_pct: {
        revenue: pct(summaryRev, cmpRev),
        cogs: pct(summaryCogs, cmpCogs),
        opex: pct(summaryOpex, cmpOpex),
        net: pct(
          summaryRev + summaryCogs + summaryOpex,
          cmpRev + cmpCogs + cmpOpex,
        ),
      },
    },
    rows,
    net_per_column: netPerCol,
  };
}

export function pnlQuery(params: PnlParams) {
  return queryOptions({
    queryKey: queryKeys.finance.pnl(params.entity, params.period, params.compare_to),
    queryFn: () => getPnl(params),
    staleTime: 60_000,
  });
}

export function periodOptions(): { value: string; label: string }[] {
  const now = new Date();
  const yr = now.getFullYear();
  const opts: { value: string; label: string }[] = [];
  for (let y = yr; y >= yr - 2; y--) {
    for (let q = 4; q >= 1; q--) {
      opts.push({ value: `${y}-Q${q}`, label: `Q${q} ${y}` });
    }
  }
  return opts;
}

export function defaultQuarter(): string {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return `${now.getFullYear()}-Q${q}`;
}

export function previousQuarter(period: string): string {
  const m = period.match(/^(\d{4})-Q([1-4])$/);
  if (!m) return defaultQuarter();
  let year = Number(m[1]);
  let q = Number(m[2]) - 1;
  if (q === 0) {
    q = 4;
    year -= 1;
  }
  return `${year}-Q${q}`;
}

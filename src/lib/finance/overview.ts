import type { SupabaseClient } from '@supabase/supabase-js';
import { convertToUsd, getLatestRates } from './currency';

export type EntityFilter = 'all' | 'royalti' | 'dixtrit' | 'personal';

export interface OverviewKpi {
  value: number;
  delta_pct: number | null;
  spark: number[];
}

export interface OverviewRunway {
  value: number;
  scenario: 'current';
}

export interface OverviewAr {
  value: number;
  overdue_count: number;
}

export interface OverviewAlert {
  id: string;
  severity: 'info' | 'warn' | 'critical';
  message: string;
  href: string;
}

export interface CashByAccountRow {
  entity: string;
  currency: string;
  balance_native: number;
  balance_usd: number;
  account_count: number;
}

export interface CashFlowMonthRow {
  month: string;
  net_usd: number;
}

export interface RecentActivityRow {
  id: string;
  date: string;
  desc: string;
  amount_usd: number;
}

export interface OverviewData {
  entity: EntityFilter;
  as_of: string;
  kpis: {
    cash_usd: OverviewKpi;
    burn_usd_per_mo: OverviewKpi;
    runway_months: OverviewRunway;
    ar_outstanding: OverviewAr;
  };
  alerts: OverviewAlert[];
  cash_flow_6mo: CashFlowMonthRow[];
  cash_by_account: CashByAccountRow[];
  recent_activity: RecentActivityRow[];
}

const ENTITY_DB: Record<Exclude<EntityFilter, 'all'>, string> = {
  royalti: 'Royalti',
  dixtrit: 'Dixtrit',
  personal: 'Personal',
};

function pctChange(curr: number, prev: number): number | null {
  if (prev === 0 || !isFinite(prev)) return null;
  return Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function getOverviewData(
  supabase: SupabaseClient,
  opts: { entity?: EntityFilter; asOf?: string } = {},
): Promise<OverviewData> {
  const entity: EntityFilter = opts.entity ?? 'all';
  const asOf = opts.asOf ?? new Date().toISOString().split('T')[0];
  const dbEntity = entity === 'all' ? null : ENTITY_DB[entity];

  const rates = await getLatestRates(supabase);

  // ── Bank accounts (entity-filtered) ──
  let accountsQuery = supabase
    .from('bank_accounts')
    .select('id, entity, currency, account_name')
    .eq('is_active', true);
  if (dbEntity) accountsQuery = accountsQuery.eq('entity', dbEntity);
  const { data: accounts } = await accountsQuery;
  const accountIds = (accounts ?? []).map((a) => a.id);

  // ── Latest balances for those accounts ──
  let balancesQuery = supabase
    .from('latest_account_balances')
    .select('account_id, balance_after, currency');
  if (accountIds.length) balancesQuery = balancesQuery.in('account_id', accountIds);
  const { data: latestBalances } = await balancesQuery;

  const balanceByAccount = new Map<string, { balance: number; currency: string }>();
  for (const row of latestBalances ?? []) {
    balanceByAccount.set(row.account_id, {
      balance: row.balance_after ?? 0,
      currency: row.currency,
    });
  }

  // ── Cash by account, grouped by entity+currency ──
  const grouped = new Map<
    string,
    { entity: string; currency: string; balance: number; balance_usd: number; count: number }
  >();
  let totalCashUsd = 0;
  for (const acct of accounts ?? []) {
    const info = balanceByAccount.get(acct.id);
    const native = info?.balance ?? 0;
    const usd = convertToUsd(native, acct.currency, rates);
    totalCashUsd += usd;
    const key = `${acct.entity}-${acct.currency}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.balance += native;
      existing.balance_usd += usd;
      existing.count += 1;
    } else {
      grouped.set(key, {
        entity: acct.entity,
        currency: acct.currency,
        balance: native,
        balance_usd: usd,
        count: 1,
      });
    }
  }
  const cashByAccount: CashByAccountRow[] = Array.from(grouped.values())
    .map((g) => ({
      entity: g.entity,
      currency: g.currency,
      balance_native: g.balance,
      balance_usd: g.balance_usd,
      account_count: g.count,
    }))
    .sort((a, b) =>
      a.entity === b.entity ? a.currency.localeCompare(b.currency) : a.entity.localeCompare(b.entity),
    );

  // ── 12-month cash flow buckets (for sparklines + 6mo chart) ──
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const startDate = `${rangeStart.getFullYear()}-${String(rangeStart.getMonth() + 1).padStart(2, '0')}-01`;

  let txnQuery = supabase
    .from('transaction_ledger')
    .select('id, txn_date, entity, type, amount, amount_usd, currency, description, counterparty')
    .gte('txn_date', startDate);
  if (dbEntity) txnQuery = txnQuery.eq('entity', dbEntity);
  const { data: txns } = await txnQuery;

  interface Bucket {
    income: number;
    expenses: number;
  }
  const buckets = new Map<string, Bucket>();
  for (let i = 0; i < 12; i++) {
    const d = new Date(rangeStart.getFullYear(), rangeStart.getMonth() + i, 1);
    buckets.set(monthKey(d), { income: 0, expenses: 0 });
  }
  for (const t of txns ?? []) {
    const k = (t.txn_date as string).substring(0, 7);
    const b = buckets.get(k);
    if (!b) continue;
    const usd =
      t.amount_usd != null
        ? Math.abs(t.amount_usd)
        : convertToUsd(Math.abs(t.amount), t.currency, rates);
    if (t.type === 'income') b.income += usd;
    else if (t.type === 'expense') b.expenses += usd;
  }
  const months = Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b));
  const cashFlow6mo: CashFlowMonthRow[] = months.slice(-6).map(([month, b]) => ({
    month,
    net_usd: b.income - b.expenses,
  }));

  // ── KPIs ──
  // Cash sparkline: closing balance backward from current totalCashUsd over last 12 months
  const closingByMonth: number[] = [];
  let running = totalCashUsd;
  for (let i = months.length - 1; i >= 0; i--) {
    closingByMonth.unshift(running);
    const b = months[i][1];
    running -= b.income - b.expenses;
  }
  const cashSpark = closingByMonth.slice(-12);

  // Burn (avg of last 6mo expenses); use last full month as "current"
  const last6Burn = months.slice(-6).map(([, b]) => b.expenses);
  const avgBurn = last6Burn.reduce((s, v) => s + v, 0) / Math.max(1, last6Burn.length);
  const monthlyBurn = last6Burn[last6Burn.length - 1] || avgBurn;
  const runwayMonths = avgBurn > 0 ? totalCashUsd / avgBurn : 0;

  // ── Receivables (overdue + outstanding) ──
  const { data: receivables } = await supabase
    .from('receivables')
    .select('id, balance_left, invoice_status, currency, invoice_date')
    .gt('balance_left', 0);
  let arTotal = 0;
  let arOverdueCount = 0;
  for (const r of receivables ?? []) {
    arTotal += convertToUsd(r.balance_left ?? 0, r.currency, rates);
    if (r.invoice_status === 'overdue') arOverdueCount += 1;
  }

  // ── Inter-company unmatched ──
  const { count: icPending } = await supabase
    .from('inter_company_entries')
    .select('*', { count: 'exact', head: true })
    .eq('reconciliation_status', 'pending');

  // ── Alerts (max 3) ──
  const alerts: OverviewAlert[] = [];
  if (arOverdueCount > 0) {
    alerts.push({
      id: 'ar-overdue',
      severity: 'warn',
      message: `${arOverdueCount} receivable${arOverdueCount === 1 ? '' : 's'} overdue`,
      href: '/finance/reports',
    });
  }
  if ((icPending ?? 0) > 0) {
    alerts.push({
      id: 'ic-pending',
      severity: 'warn',
      message: `${icPending} inter-company entr${icPending === 1 ? 'y' : 'ies'} need review`,
      href: '/finance/reconciliation',
    });
  }
  if (runwayMonths > 0 && runwayMonths < 6) {
    alerts.push({
      id: 'runway-low',
      severity: 'critical',
      message: `Runway under 6 months (${runwayMonths.toFixed(1)} mo @ current burn)`,
      href: '/finance/runway',
    });
  }

  // ── Recent activity (last 7 days) ──
  const sevenAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  let recentQuery = supabase
    .from('transaction_ledger')
    .select('id, txn_date, description, counterparty, amount, amount_usd, currency, type')
    .gte('txn_date', sevenAgo)
    .order('txn_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(10);
  if (dbEntity) recentQuery = recentQuery.eq('entity', dbEntity);
  const { data: recent } = await recentQuery;
  const recentActivity: RecentActivityRow[] = (recent ?? []).map((t) => {
    const usd =
      t.amount_usd != null ? t.amount_usd : convertToUsd(t.amount, t.currency, rates);
    const signed =
      t.type === 'expense'
        ? -Math.abs(usd)
        : t.type === 'income'
          ? Math.abs(usd)
          : usd;
    return {
      id: t.id,
      date: t.txn_date,
      desc: t.description ?? t.counterparty ?? '—',
      amount_usd: signed,
    };
  });

  return {
    entity,
    as_of: asOf,
    kpis: {
      cash_usd: {
        value: Math.round(totalCashUsd),
        delta_pct: pctChange(cashSpark.at(-1) ?? 0, cashSpark.at(-2) ?? 0),
        spark: cashSpark.map((v) => Math.round(v)),
      },
      burn_usd_per_mo: {
        value: Math.round(monthlyBurn),
        delta_pct: pctChange(last6Burn.at(-1) ?? 0, avgBurn),
        spark: last6Burn.map((v) => Math.round(v)),
      },
      runway_months: { value: Math.round(runwayMonths * 10) / 10, scenario: 'current' },
      ar_outstanding: { value: Math.round(arTotal), overdue_count: arOverdueCount },
    },
    alerts,
    cash_flow_6mo: cashFlow6mo,
    cash_by_account: cashByAccount,
    recent_activity: recentActivity,
  };
}

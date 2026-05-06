import type { SupabaseClient } from '@supabase/supabase-js';
import { convertToUsd, getLatestRates } from './currency';
import type { EntityFilter } from './overview';

export type MatchStatus = 'paired' | 'unmatched' | 'disputed' | 'n/a';

export interface TxnFilters {
  entity: EntityFilter;
  date_from?: string;
  date_to?: string;
  account_id?: string;
  category?: string;
  currency?: '' | 'USD' | 'NGN' | 'EUR' | 'GBP';
  match?: '' | 'paired' | 'unmatched' | 'disputed';
  search?: string;
  page: number;
  per_page: number;
}

export const DEFAULT_TXN_FILTERS: TxnFilters = {
  entity: 'all',
  page: 1,
  per_page: 50,
};

const ENTITY_DB: Record<Exclude<EntityFilter, 'all'>, string> = {
  royalti: 'Royalti',
  dixtrit: 'Dixtrit',
  personal: 'Personal',
};

export interface AccountingTxnRow {
  id: string;
  date: string;
  entity: string;
  account: { id: string; label: string; last4: string | null } | null;
  description: string;
  amount_native: number;
  currency: string;
  amount_usd: number;
  category: string | null;
  subcategory: string | null;
  match_status: MatchStatus;
  paired_with: string | null;
  classification_rule: string | null;
  source: { type: string | null; imported_at: string | null };
}

export interface AccountingTxnResponse {
  meta: {
    total: number;
    page: number;
    per_page: number;
    filters_applied: Partial<TxnFilters>;
  };
  summary: {
    inflow_usd: number;
    outflow_usd: number;
    net_usd: number;
    delta_qoq: { inflow_pct: number | null; outflow_pct: number | null; net_pct: number | null };
  };
  transactions: AccountingTxnRow[];
}

function deriveMatchStatus(row: {
  reconciliation_status: string | null;
  linked_txn_id: string | null;
  category: string | null;
}): MatchStatus {
  const isInterCo =
    row.category === 'inter_company' ||
    (row.category ?? '').toLowerCase().includes('inter');
  if (!isInterCo) return 'n/a';
  const r = (row.reconciliation_status ?? '').toLowerCase();
  if (r === 'matched' || r === 'cleared' || row.linked_txn_id) return 'paired';
  if (r === 'disputed') return 'disputed';
  return 'unmatched';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyTxnFilters(query: any, filters: TxnFilters): any {
  let q = query;
  if (filters.entity !== 'all') q = q.eq('entity', ENTITY_DB[filters.entity]);
  if (filters.date_from) q = q.gte('txn_date', filters.date_from);
  if (filters.date_to) q = q.lte('txn_date', filters.date_to);
  if (filters.account_id) q = q.eq('account_id', filters.account_id);
  if (filters.category) q = q.eq('category', filters.category);
  if (filters.currency) q = q.eq('currency', filters.currency);
  if (filters.search) {
    const s = filters.search.replace(/[%,]/g, '');
    q = q.or(`description.ilike.%${s}%,counterparty.ilike.%${s}%`);
  }
  if (filters.match === 'paired') {
    q = q.not('linked_txn_id', 'is', null);
  } else if (filters.match === 'unmatched') {
    q = q.eq('category', 'inter_company').is('linked_txn_id', null);
  } else if (filters.match === 'disputed') {
    q = q.eq('reconciliation_status', 'disputed');
  }
  return q;
}

export async function fetchTransactions(
  supabase: SupabaseClient,
  filters: TxnFilters,
): Promise<AccountingTxnResponse> {
  const rates = await getLatestRates(supabase);

  const { data: accounts } = await supabase
    .from('bank_accounts')
    .select('id, account_name, sheet_name, currency, entity');
  const accountById = new Map<
    string,
    { label: string; last4: string | null }
  >();
  for (const a of accounts ?? []) {
    const last4Match = (a.account_name ?? '').match(/(\d{4})\s*$/);
    accountById.set(a.id, {
      label: a.sheet_name || a.account_name || `${a.entity}-${a.currency}`,
      last4: last4Match ? last4Match[1] : null,
    });
  }

  let mainQuery = supabase
    .from('transaction_ledger')
    .select(
      'id, txn_date, entity, account_id, amount, amount_usd, currency, description, counterparty, category, subcategory, type, reconciliation_status, linked_txn_id, source_ref, processed_at',
      { count: 'exact' },
    );
  mainQuery = applyTxnFilters(mainQuery, filters);
  mainQuery = mainQuery
    .order('txn_date', { ascending: false })
    .order('created_at', { ascending: false });

  const from = (filters.page - 1) * filters.per_page;
  const to = from + filters.per_page - 1;
  mainQuery = mainQuery.range(from, to);

  let aggQuery = supabase
    .from('transaction_ledger')
    .select('type, amount, amount_usd, currency');
  aggQuery = applyTxnFilters(aggQuery, filters);

  const [mainRes, aggRes] = await Promise.all([mainQuery, aggQuery]);
  if (mainRes.error) throw new Error(mainRes.error.message);
  if (aggRes.error) throw new Error(aggRes.error.message);

  let inflow = 0;
  let outflow = 0;
  for (const r of aggRes.data ?? []) {
    const usd =
      r.amount_usd != null
        ? Math.abs(r.amount_usd)
        : convertToUsd(Math.abs(r.amount), r.currency, rates);
    if (r.type === 'income') inflow += usd;
    else if (r.type === 'expense') outflow += usd;
  }

  const transactions: AccountingTxnRow[] = (mainRes.data ?? []).map((r) => {
    const usd =
      r.amount_usd != null ? r.amount_usd : convertToUsd(r.amount, r.currency, rates);
    const signed =
      r.type === 'expense'
        ? -Math.abs(usd)
        : r.type === 'income'
          ? Math.abs(usd)
          : usd;
    const acct = accountById.get(r.account_id);
    return {
      id: r.id,
      date: r.txn_date,
      entity: r.entity,
      account: acct ? { id: r.account_id, label: acct.label, last4: acct.last4 } : null,
      description: r.description ?? r.counterparty ?? '—',
      amount_native: r.amount,
      currency: r.currency,
      amount_usd: signed,
      category: r.category,
      subcategory: r.subcategory,
      match_status: deriveMatchStatus(r),
      paired_with: r.linked_txn_id,
      classification_rule: null,
      source: { type: r.source_ref ?? null, imported_at: r.processed_at ?? null },
    };
  });

  return {
    meta: {
      total: mainRes.count ?? 0,
      page: filters.page,
      per_page: filters.per_page,
      filters_applied: filters,
    },
    summary: {
      inflow_usd: Math.round(inflow),
      outflow_usd: -Math.round(outflow),
      net_usd: Math.round(inflow - outflow),
      delta_qoq: { inflow_pct: null, outflow_pct: null, net_pct: null },
    },
    transactions,
  };
}

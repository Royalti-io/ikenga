import type { SupabaseClient } from '@supabase/supabase-js';
import { convertToUsd, getLatestRates } from './currency';

export type InvoiceStatus = 'paid' | 'overdue' | 'partial' | 'written_off' | string;
export type CollectionStatus =
  | 'not_started'
  | 'in_progress'
  | 'escalated'
  | 'resolved'
  | string;

export interface Receivable {
  id: string;
  document_no: string | null;
  invoice_date: string;
  due_date: string | null;
  customer: string;
  customer_email: string | null;
  description: string | null;
  total_amount: number;
  amount_paid: number;
  balance_left: number;
  balance_left_usd: number;
  currency: string;
  invoice_status: InvoiceStatus;
  collection_status: CollectionStatus | null;
  last_contact_date: string | null;
  notes: string | null;
  days_overdue: number;
}

export interface AgingBucket {
  label: string;
  range: string;
  count: number;
  amount_usd: number;
  color: string;
}

export interface ReceivablesFilters {
  collection_status?: string;
  aging_bucket?: 'current' | '1-30' | '31-60' | '60+' | '';
  search?: string;
  page: number;
  pageSize: number;
}

export interface ReceivablesPageData {
  receivables: Receivable[];
  agingBuckets: AgingBucket[];
  totals: {
    totalOutstanding: number;
    totalOverdue: number;
    overdueCount: number;
  };
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
  filterOptions: {
    collectionStatuses: string[];
  };
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

function bucketOf(daysOverdue: number): AgingBucket['label'] {
  if (daysOverdue <= 0) return 'Current';
  if (daysOverdue <= 30) return '1-30 Days';
  if (daysOverdue <= 60) return '31-60 Days';
  return '60+ Days';
}

export async function fetchReceivables(
  supabase: SupabaseClient,
  filters: ReceivablesFilters,
): Promise<ReceivablesPageData> {
  const rates = await getLatestRates(supabase);

  // Pull all open receivables (balance > 0) for aggregates; paginate at the end.
  let query = supabase
    .from('receivables')
    .select(
      'id, document_no, invoice_date, due_date, customer, customer_email, description, total_amount, amount_paid, balance_left, currency, invoice_status, collection_status, last_contact_date, notes',
    )
    .gt('balance_left', 0)
    .order('due_date', { ascending: true, nullsFirst: false });

  if (filters.collection_status) {
    query = query.eq('collection_status', filters.collection_status);
  }
  if (filters.search) {
    const s = filters.search.replace(/[%,]/g, '');
    query = query.or(
      `customer.ilike.%${s}%,document_no.ilike.%${s}%,description.ilike.%${s}%`,
    );
  }

  const { data: rows, error } = await query;
  if (error) throw new Error(error.message);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const all: Receivable[] = (rows ?? []).map((r) => {
    const due = r.due_date ? new Date(r.due_date + 'T00:00:00Z') : null;
    const daysOverdue = due ? daysBetween(today, due) : 0;
    return {
      id: r.id,
      document_no: r.document_no,
      invoice_date: r.invoice_date,
      due_date: r.due_date,
      customer: r.customer ?? '—',
      customer_email: r.customer_email,
      description: r.description,
      total_amount: r.total_amount ?? 0,
      amount_paid: r.amount_paid ?? 0,
      balance_left: r.balance_left ?? 0,
      balance_left_usd: convertToUsd(r.balance_left ?? 0, r.currency, rates),
      currency: r.currency,
      invoice_status: r.invoice_status ?? 'open',
      collection_status: r.collection_status,
      last_contact_date: r.last_contact_date,
      notes: r.notes,
      days_overdue: daysOverdue,
    };
  });

  // Apply aging bucket filter
  let filtered = all;
  if (filters.aging_bucket) {
    filtered = all.filter((r) => {
      if (filters.aging_bucket === 'current') return r.days_overdue <= 0;
      if (filters.aging_bucket === '1-30') return r.days_overdue >= 1 && r.days_overdue <= 30;
      if (filters.aging_bucket === '31-60') return r.days_overdue >= 31 && r.days_overdue <= 60;
      if (filters.aging_bucket === '60+') return r.days_overdue > 60;
      return true;
    });
  }

  // Aging buckets (computed across `all` for accurate totals, not filtered set)
  const bucketMap = new Map<string, { count: number; amount_usd: number }>([
    ['Current', { count: 0, amount_usd: 0 }],
    ['1-30 Days', { count: 0, amount_usd: 0 }],
    ['31-60 Days', { count: 0, amount_usd: 0 }],
    ['60+ Days', { count: 0, amount_usd: 0 }],
  ]);
  for (const r of all) {
    const b = bucketMap.get(bucketOf(r.days_overdue))!;
    b.count += 1;
    b.amount_usd += r.balance_left_usd;
  }

  const colors: Record<string, string> = {
    Current: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    '1-30 Days': 'border-amber-200 bg-amber-50 text-amber-800',
    '31-60 Days': 'border-orange-200 bg-orange-50 text-orange-800',
    '60+ Days': 'border-red-200 bg-red-50 text-red-800',
  };
  const ranges: Record<string, string> = {
    Current: 'Not yet due',
    '1-30 Days': '1-30 days overdue',
    '31-60 Days': '31-60 days overdue',
    '60+ Days': 'More than 60 days',
  };

  const agingBuckets: AgingBucket[] = Array.from(bucketMap.entries()).map(([label, b]) => ({
    label,
    range: ranges[label],
    count: b.count,
    amount_usd: Math.round(b.amount_usd),
    color: colors[label],
  }));

  // Totals
  const totalOutstanding = all.reduce((s, r) => s + r.balance_left_usd, 0);
  const overdue = all.filter((r) => r.days_overdue > 0);
  const totalOverdue = overdue.reduce((s, r) => s + r.balance_left_usd, 0);

  // Pagination
  const totalCount = filtered.length;
  const start = (filters.page - 1) * filters.pageSize;
  const paged = filtered.slice(start, start + filters.pageSize);

  // Distinct collection statuses for filter dropdown
  const collectionStatuses = Array.from(
    new Set(all.map((r) => r.collection_status).filter(Boolean)),
  ) as string[];

  return {
    receivables: paged,
    agingBuckets,
    totals: {
      totalOutstanding: Math.round(totalOutstanding),
      totalOverdue: Math.round(totalOverdue),
      overdueCount: overdue.length,
    },
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / filters.pageSize)),
    },
    filterOptions: {
      collectionStatuses: collectionStatuses.sort(),
    },
  };
}

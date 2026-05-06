import type { SupabaseClient } from '@supabase/supabase-js';
import { convertToUsd, getLatestRates } from './currency';

export type ICEntity = 'royalti' | 'dixtrit' | 'personal';

const FLOW_TAG: Record<string, string> = {
  'royalti->dixtrit': 'SHL-DIXTRIT',
  'dixtrit->royalti': 'SHL-DIXTRIT',
  'royalti->personal': 'SHL-PERSONAL',
  'personal->royalti': 'SHL-PERSONAL',
  'dixtrit->personal': 'ICA-TRADE',
  'personal->dixtrit': 'ICA-TRADE',
};

export interface MatrixCell {
  from_entity: ICEntity;
  to_entity: ICEntity;
  flow_tag: string;
  net_balance_usd: number;
  direction: 'owed_to_from' | 'owed_to_to' | 'settled';
  entry_count: number;
  unmatched_count: number;
  disputed_count: number;
}

export async function getMatrix(
  supabase: SupabaseClient,
  asOf?: string,
): Promise<{ as_of: string; cells: MatrixCell[] }> {
  const dateCutoff = asOf ?? new Date().toISOString().split('T')[0];
  const rates = await getLatestRates(supabase);

  const { data: entries } = await supabase
    .from('inter_company_entries')
    .select(
      'source_entity, destination_entity, ledger_account, amount, amount_usd, currency, reconciliation_status, entry_date',
    )
    .lte('entry_date', dateCutoff);

  const buckets = new Map<
    string,
    {
      from: ICEntity;
      to: ICEntity;
      net: number;
      entries: number;
      unmatched: number;
      disputed: number;
    }
  >();

  const lc = (s: string): ICEntity => {
    const v = (s ?? '').toLowerCase();
    if (v === 'royalti' || v === 'dixtrit' || v === 'personal') return v;
    return 'personal';
  };

  for (const e of entries ?? []) {
    const from = lc(e.source_entity);
    const to = lc(e.destination_entity);
    if (from === to) continue;
    const key = `${from}->${to}`;
    const usd =
      e.amount_usd != null
        ? Math.abs(e.amount_usd)
        : convertToUsd(Math.abs(e.amount), e.currency, rates);
    const r = (e.reconciliation_status ?? '').toLowerCase();
    const b =
      buckets.get(key) ?? { from, to, net: 0, entries: 0, unmatched: 0, disputed: 0 };
    b.net += usd;
    b.entries += 1;
    if (r === 'pending') b.unmatched += 1;
    else if (r === 'disputed') b.disputed += 1;
    buckets.set(key, b);
  }

  const ents: ICEntity[] = ['royalti', 'dixtrit', 'personal'];
  const cells: MatrixCell[] = [];
  for (const f of ents) {
    for (const t of ents) {
      if (f === t) continue;
      const fwd = buckets.get(`${f}->${t}`);
      const rev = buckets.get(`${t}->${f}`);
      const net = (fwd?.net ?? 0) - (rev?.net ?? 0);
      const entry_count = (fwd?.entries ?? 0) + (rev?.entries ?? 0);
      const unmatched_count = (fwd?.unmatched ?? 0) + (rev?.unmatched ?? 0);
      const disputed_count = (fwd?.disputed ?? 0) + (rev?.disputed ?? 0);
      let direction: MatrixCell['direction'] = 'settled';
      if (net > 0.01) direction = 'owed_to_from';
      else if (net < -0.01) direction = 'owed_to_to';
      cells.push({
        from_entity: f,
        to_entity: t,
        flow_tag: FLOW_TAG[`${f}->${t}`] ?? '',
        net_balance_usd: Math.round(Math.abs(net) * 100) / 100,
        direction,
        entry_count,
        unmatched_count,
        disputed_count,
      });
    }
  }

  return { as_of: dateCutoff, cells };
}

export interface QueuePair {
  id: string;
  status: 'matched' | 'suggested' | 'unmatched' | 'disputed';
  left: { txn_id: string; entity: string; date: string; amount_usd: number; memo: string };
  right: { txn_id: string; entity: string; date: string; amount_usd: number; memo: string } | null;
  flow_tag: string;
  match_score: number | null;
  match_reason: string | null;
}

export interface QueueResponse {
  stats: { unmatched: number; suggested: number; disputed: number; match_rate_pct: number };
  pairs: QueuePair[];
}

interface RawTxn {
  id: string;
  txn_date: string;
  entity: string;
  amount_usd: number | null;
  amount: number;
  currency: string;
  description: string | null;
  counterparty: string | null;
  category: string | null;
  subcategory: string | null;
  reconciliation_status: string | null;
  linked_txn_id: string | null;
}

function memoSimilarity(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).flatMap((w) => {
        if (w.length <= 3) return [w];
        const grams: string[] = [];
        for (let i = 0; i <= w.length - 3; i++) grams.push(w.slice(i, i + 3));
        return grams;
      }),
    );
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.sqrt(A.size * B.size);
}

function pickFlowTag(txn: RawTxn): string {
  const sub = (txn.subcategory ?? '').toUpperCase();
  if (sub.includes('DIXTRIT')) return 'SHL-DIXTRIT';
  if (sub.includes('PERSONAL')) return 'SHL-PERSONAL';
  if (sub.includes('ICA') || sub.includes('TRADE')) return 'ICA-TRADE';
  return 'INTER-CO';
}

function memo(t: RawTxn): string {
  return t.description ?? t.counterparty ?? '';
}

export async function getQueue(
  supabase: SupabaseClient,
  status: 'all' | 'unmatched' | 'suggested' | 'disputed' | 'matched' = 'all',
  limit = 50,
): Promise<QueueResponse> {
  const rates = await getLatestRates(supabase);

  const { data: txns } = await supabase
    .from('transaction_ledger')
    .select(
      'id, txn_date, entity, amount, amount_usd, currency, description, counterparty, category, subcategory, reconciliation_status, linked_txn_id',
    )
    .eq('category', 'inter_company')
    .order('txn_date', { ascending: false })
    .limit(800);

  const all = (txns ?? []) as RawTxn[];
  const usd = (t: RawTxn) =>
    t.amount_usd != null ? t.amount_usd : convertToUsd(t.amount, t.currency, rates);

  const matchedPairs: QueuePair[] = [];
  const matchedIds = new Set<string>();
  for (const t of all) {
    if (t.linked_txn_id && !matchedIds.has(t.id)) {
      const partner = all.find((p) => p.id === t.linked_txn_id);
      if (partner) {
        matchedIds.add(t.id);
        matchedIds.add(partner.id);
        matchedPairs.push({
          id: `pair_${t.id}_${partner.id}`,
          status: 'matched',
          left: {
            txn_id: t.id,
            entity: t.entity,
            date: t.txn_date,
            amount_usd: usd(t),
            memo: memo(t),
          },
          right: {
            txn_id: partner.id,
            entity: partner.entity,
            date: partner.txn_date,
            amount_usd: usd(partner),
            memo: memo(partner),
          },
          flow_tag: pickFlowTag(t),
          match_score: 1,
          match_reason: 'linked',
        });
      }
    }
  }

  const unmatched = all.filter((t) => !t.linked_txn_id);
  const disputed = unmatched.filter(
    (t) => (t.reconciliation_status ?? '').toLowerCase() === 'disputed',
  );
  const trulyUnmatched = unmatched.filter(
    (t) => (t.reconciliation_status ?? '').toLowerCase() !== 'disputed',
  );

  const suggested: QueuePair[] = [];
  const usedSuggest = new Set<string>();
  for (const a of trulyUnmatched) {
    if (usedSuggest.has(a.id)) continue;
    const aUsd = usd(a);
    const aTag = pickFlowTag(a);
    const aDate = new Date(a.txn_date + 'T00:00:00Z').getTime();

    let best: { partner: RawTxn; score: number; reason: string } | null = null;
    for (const b of trulyUnmatched) {
      if (b.id === a.id || usedSuggest.has(b.id)) continue;
      const bUsd = usd(b);
      if (Math.abs(aUsd + bUsd) > 0.01) continue;
      if (pickFlowTag(b) !== aTag) continue;
      const bDate = new Date(b.txn_date + 'T00:00:00Z').getTime();
      const dayDelta = Math.abs(aDate - bDate) / (1000 * 60 * 60 * 24);
      if (dayDelta > 7) continue;
      const sim = memoSimilarity(memo(a), memo(b));
      const amountDelta = Math.abs(Math.abs(aUsd) - Math.abs(bUsd));
      const score = sim - dayDelta * 0.001 - amountDelta * 0.0001;
      if (!best || score > best.score) {
        best = {
          partner: b,
          score,
          reason: sim >= 0.5 ? 'memo + amount + window' : 'amount + window + flow tag',
        };
      }
    }

    if (best) {
      usedSuggest.add(a.id);
      usedSuggest.add(best.partner.id);
      suggested.push({
        id: `pair_sug_${a.id}_${best.partner.id}`,
        status: 'suggested',
        left: { txn_id: a.id, entity: a.entity, date: a.txn_date, amount_usd: aUsd, memo: memo(a) },
        right: {
          txn_id: best.partner.id,
          entity: best.partner.entity,
          date: best.partner.txn_date,
          amount_usd: usd(best.partner),
          memo: memo(best.partner),
        },
        flow_tag: aTag,
        match_score: Math.min(1, Math.max(0, 0.7 + best.score * 0.3)),
        match_reason: best.reason,
      });
    }
  }

  const unmatchedSingles: QueuePair[] = trulyUnmatched
    .filter((t) => !usedSuggest.has(t.id))
    .map((t) => ({
      id: `pair_un_${t.id}`,
      status: 'unmatched' as const,
      left: { txn_id: t.id, entity: t.entity, date: t.txn_date, amount_usd: usd(t), memo: memo(t) },
      right: null,
      flow_tag: pickFlowTag(t),
      match_score: null,
      match_reason: null,
    }));

  const disputedPairs: QueuePair[] = disputed.map((t) => {
    const partner = t.linked_txn_id ? all.find((p) => p.id === t.linked_txn_id) : null;
    return {
      id: `pair_disp_${t.id}`,
      status: 'disputed' as const,
      left: { txn_id: t.id, entity: t.entity, date: t.txn_date, amount_usd: usd(t), memo: memo(t) },
      right: partner
        ? {
            txn_id: partner.id,
            entity: partner.entity,
            date: partner.txn_date,
            amount_usd: usd(partner),
            memo: memo(partner),
          }
        : null,
      flow_tag: pickFlowTag(t),
      match_score: null,
      match_reason: 'flagged',
    };
  });

  let pairs: QueuePair[] = [];
  if (status === 'all')
    pairs = [...suggested, ...unmatchedSingles, ...disputedPairs, ...matchedPairs];
  else if (status === 'suggested') pairs = suggested;
  else if (status === 'unmatched') pairs = unmatchedSingles;
  else if (status === 'disputed') pairs = disputedPairs;
  else if (status === 'matched') pairs = matchedPairs;

  pairs = pairs.slice(0, limit);

  const totalIc = all.length || 1;
  const matched = matchedPairs.length * 2;
  const matchRate = (matched / totalIc) * 100;

  return {
    stats: {
      unmatched: unmatchedSingles.length,
      suggested: suggested.length,
      disputed: disputedPairs.length,
      match_rate_pct: Math.round(matchRate * 10) / 10,
    },
    pairs,
  };
}

export async function confirmPair(
  supabase: SupabaseClient,
  pairId: string,
): Promise<{ ok: boolean }> {
  const m = pairId.match(/^pair_(?:sug_)?([^_]+)_(.+)$/);
  if (!m) return { ok: false };
  const [, a, b] = m;
  await supabase
    .from('transaction_ledger')
    .update({ linked_txn_id: b, reconciliation_status: 'matched' })
    .eq('id', a);
  await supabase
    .from('transaction_ledger')
    .update({ linked_txn_id: a, reconciliation_status: 'matched' })
    .eq('id', b);
  return { ok: true };
}

export async function disputePair(
  supabase: SupabaseClient,
  pairId: string,
  reason: string,
): Promise<{ ok: boolean }> {
  const m = pairId.match(/^pair_(?:un_|sug_|disp_)?(.+?)(?:_(.+))?$/);
  if (!m) return { ok: false };
  const [, a, b] = m;
  await supabase
    .from('transaction_ledger')
    .update({ reconciliation_status: 'disputed', notes: reason })
    .eq('id', a);
  if (b) {
    await supabase
      .from('transaction_ledger')
      .update({ reconciliation_status: 'disputed', notes: reason })
      .eq('id', b);
  }
  return { ok: true };
}

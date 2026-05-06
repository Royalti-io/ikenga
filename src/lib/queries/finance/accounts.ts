import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';
import { convertToUsd, getLatestRates } from '@/lib/finance/currency';

export interface BankAccountRow {
  id: string;
  entity: string;
  account_name: string | null;
  sheet_name: string | null;
  currency: string;
  is_active: boolean;
  balance_native: number;
  balance_usd: number;
  last_balance_at: string | null;
}

async function fetchAccounts(): Promise<BankAccountRow[]> {
  const rates = await getLatestRates(supabase);

  const { data: accounts, error } = await supabase
    .from('bank_accounts')
    .select('id, entity, account_name, sheet_name, currency, is_active')
    .order('entity')
    .order('currency');
  if (error) throw error;

  const ids = (accounts ?? []).map((a) => a.id);
  let balances: { account_id: string; balance_after: number; recorded_at: string | null }[] = [];
  if (ids.length) {
    const { data: rows } = await supabase
      .from('latest_account_balances')
      .select('account_id, balance_after, recorded_at')
      .in('account_id', ids);
    balances = rows ?? [];
  }
  const byId = new Map(balances.map((b) => [b.account_id, b]));

  return (accounts ?? []).map((a) => {
    const b = byId.get(a.id);
    const native = b?.balance_after ?? 0;
    return {
      id: a.id,
      entity: a.entity,
      account_name: a.account_name,
      sheet_name: a.sheet_name,
      currency: a.currency,
      is_active: a.is_active,
      balance_native: native,
      balance_usd: convertToUsd(native, a.currency, rates),
      last_balance_at: b?.recorded_at ?? null,
    };
  });
}

export function accountsQuery() {
  return queryOptions({
    queryKey: queryKeys.finance.accounts(),
    queryFn: fetchAccounts,
    staleTime: 60_000,
  });
}

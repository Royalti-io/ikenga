import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';
import {
  fetchTransactions,
  type TxnFilters,
  type AccountingTxnResponse,
} from '@/lib/finance/transactions';

export function transactionsQuery(filters: TxnFilters) {
  return queryOptions<AccountingTxnResponse>({
    queryKey: queryKeys.finance.transactions(filters),
    queryFn: () => fetchTransactions(supabase, filters),
    staleTime: 30_000,
  });
}

export interface TransactionDetail {
  id: string;
  txn_date: string;
  entity: string;
  account_id: string | null;
  amount: number;
  amount_usd: number | null;
  currency: string;
  description: string | null;
  counterparty: string | null;
  category: string | null;
  subcategory: string | null;
  type: string | null;
  reconciliation_status: string | null;
  linked_txn_id: string | null;
  source_ref: string | null;
  notes: string | null;
  processed_at: string | null;
  created_at: string;
}

export function transactionDetailQuery(id: string) {
  return queryOptions<TransactionDetail | null>({
    queryKey: queryKeys.finance.transaction(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('transaction_ledger')
        .select(
          'id, txn_date, entity, account_id, amount, amount_usd, currency, description, counterparty, category, subcategory, type, reconciliation_status, linked_txn_id, source_ref, notes, processed_at, created_at',
        )
        .eq('id', id)
        .single();
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }
      return data as TransactionDetail;
    },
    enabled: !!id,
  });
}

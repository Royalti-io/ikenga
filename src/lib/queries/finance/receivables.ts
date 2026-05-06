import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import {
  fetchReceivables,
  type ReceivablesFilters,
  type ReceivablesPageData,
} from '@/lib/finance/receivables';

export function receivablesQuery(filters: ReceivablesFilters) {
  return queryOptions<ReceivablesPageData>({
    queryKey: ['finance', 'receivables', filters] as const,
    queryFn: () => fetchReceivables(supabase, filters),
    staleTime: 30_000,
  });
}

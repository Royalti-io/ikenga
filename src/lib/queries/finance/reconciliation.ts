import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';
import { getMatrix, getQueue } from '@/lib/finance/inter-company';

export function matrixQuery(asOf?: string) {
  return queryOptions({
    queryKey: queryKeys.finance.matrix(asOf),
    queryFn: () => getMatrix(supabase, asOf),
    staleTime: 30_000,
  });
}

export function queueQuery(
  tab: 'all' | 'unmatched' | 'suggested' | 'disputed' | 'matched' = 'all',
) {
  return queryOptions({
    queryKey: queryKeys.finance.queue(tab),
    queryFn: () => getQueue(supabase, tab, 100),
    staleTime: 15_000,
  });
}

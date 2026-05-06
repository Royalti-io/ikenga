import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';
import { getOverviewData, type EntityFilter } from '@/lib/finance/overview';

export function overviewQuery(entity: EntityFilter = 'all') {
  return queryOptions({
    queryKey: queryKeys.finance.overview(entity),
    queryFn: () => getOverviewData(supabase, { entity }),
    staleTime: 60_000,
  });
}

import { queryOptions } from '@tanstack/react-query';
import { paActionsRun } from '@/lib/tauri-cmd';

export interface CrmLookupResult {
  email: string;
  tenant: { id: string; name: string; sub: string | null } | null;
  last_touch: { at: string; subject: string; direction: 'out' | 'in' } | null;
  health: { label: string; tone: 'ok' | 'warn' | 'danger'; sub: string | null } | null;
  sequence: {
    id: string;
    name: string;
    step: number | null;
    total: number | null;
  } | null;
  catalog: { products: number; tracks: number; sub: string | null } | null;
  open_balance: { amount_usd: number; sub: string | null } | null;
  owner: { name: string; sub: string | null } | null;
  risk_flag: { label: string; tone: 'ok' | 'warn' | 'danger'; sub: string | null } | null;
  in_crm: boolean;
}

export function crmLookupQuery(email: string | null | undefined) {
  return queryOptions({
    queryKey: ['crm_lookup', (email ?? '').toLowerCase()] as const,
    enabled: !!email,
    staleTime: 60_000,
    queryFn: async (): Promise<CrmLookupResult | null> => {
      if (!email) return null;
      const outcome = await paActionsRun('crm-lookup', [email]);
      if (!outcome.ok) return null;
      // Sidecar returns null when nothing found.
      return (outcome.result as CrmLookupResult | null) ?? null;
    },
  });
}

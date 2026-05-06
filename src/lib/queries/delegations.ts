import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';
import type { Task, AssigneeType } from './tasks';

export type DelegationStatus =
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'blocked';

export interface Delegation {
  id: string;
  task_id: string;
  delegated_to: string;
  delegate_type: AssigneeType;
  status: DelegationStatus;
  notes: string | null;
  assigned_at: string;
  completed_at: string | null;
  updated_at: string;
}

export interface DelegationWithTask extends Delegation {
  tasks: Task | null;
}

export interface DelegationsListFilters {
  status?: string;
  delegateType?: string;
  delegatedTo?: string;
  search?: string;
}

export function delegationsListQuery(filters: DelegationsListFilters) {
  const filterKey = JSON.stringify(filters);
  return {
    queryKey: queryKeys.delegations.list(filterKey),
    queryFn: async (): Promise<DelegationWithTask[]> => {
      let q = supabase
        .from('delegations')
        .select('*, tasks(*)')
        .order('assigned_at', { ascending: false })
        .limit(200);

      if (filters.status) q = q.eq('status', filters.status);
      if (filters.delegateType) q = q.eq('delegate_type', filters.delegateType);
      if (filters.delegatedTo) q = q.eq('delegated_to', filters.delegatedTo);

      const { data, error } = await q;
      if (error) throw error;
      let rows = (data ?? []) as DelegationWithTask[];

      if (filters.search) {
        const s = filters.search.toLowerCase();
        rows = rows.filter(
          (d) =>
            d.tasks?.title?.toLowerCase().includes(s) ||
            d.notes?.toLowerCase().includes(s),
        );
      }

      return rows;
    },
  };
}

export function delegationDetailQuery(id: string) {
  return {
    queryKey: queryKeys.delegations.detail(id),
    queryFn: async (): Promise<DelegationWithTask | null> => {
      const { data, error } = await supabase
        .from('delegations')
        .select('*, tasks(*)')
        .eq('id', id)
        .single();
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }
      return data as DelegationWithTask;
    },
  };
}

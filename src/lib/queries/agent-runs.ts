import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';

export type AgentRunStatus = 'running' | 'completed' | 'failed';
export type RunTrigger = 'cron' | 'manual' | 'webhook';

export interface AgentRun {
  id: string;
  agent_name: string;
  command: string | null;
  status: AgentRunStatus;
  output_summary: string | null;
  triggered_by: RunTrigger;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  claude_session_id: string | null;
  working_dir: string | null;
  last_activity_at: string | null;
}

export interface AgentRunsFilters {
  status?: string;
  agentName?: string;
  triggeredBy?: string;
}

export function agentRunsListQuery(filters: AgentRunsFilters) {
  const filterKey = JSON.stringify(filters);
  return {
    queryKey: queryKeys.agentRuns.list(filterKey),
    queryFn: async (): Promise<AgentRun[]> => {
      let q = supabase
        .from('agent_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(100);

      if (filters.status) q = q.eq('status', filters.status);
      if (filters.agentName) q = q.eq('agent_name', filters.agentName);
      if (filters.triggeredBy) q = q.eq('triggered_by', filters.triggeredBy);

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as AgentRun[];
    },
  };
}

export function agentNamesQuery() {
  return {
    queryKey: [...queryKeys.agentRuns.all, 'names'] as const,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('agent_runs')
        .select('agent_name')
        .order('agent_name');
      if (error) throw error;
      const set = new Set<string>();
      for (const row of data ?? []) {
        if (row.agent_name) set.add(row.agent_name);
      }
      return [...set].sort();
    },
  };
}

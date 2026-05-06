import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'blocked';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type AssigneeType = 'human' | 'agent';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_to: string | null;
  assignee_type: AssigneeType | null;
  category: string | null;
  tags: string[] | null;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  progress_pct: number | null;
  outcome_notes: string | null;
  parent_task_id: string | null;
  blocked_by_task_id: string | null;
  source_email_id: string | null;
  agent_source: string | null;
  initiative_id: string | null;
  risk_id: string | null;
  effort_estimate: string | null;
  execution_mode: 'autonomous' | 'report' | 'approval_required' | null;
  task_result: string | null;
  claude_session_id: string | null;
  working_dir: string | null;
}

export const TASKS_LIST_COLUMNS =
  'id, title, description, status, priority, assigned_to, assignee_type, category, due_date, created_at, progress_pct, outcome_notes';

export function taskDetailQuery(id: string) {
  return {
    queryKey: queryKeys.tasks.detail(id),
    queryFn: async (): Promise<Task | null> => {
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('id', id)
        .single();
      if (error) {
        if (error.code === 'PGRST116') return null; // not found
        throw error;
      }
      return data as Task;
    },
  };
}

export function subtasksQuery(parentId: string) {
  return {
    queryKey: queryKeys.tasks.subtasks(parentId),
    queryFn: async (): Promise<Task[]> => {
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('parent_task_id', parentId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as Task[];
    },
  };
}

export function blockingTaskQuery(blockingId: string | null) {
  return {
    queryKey: queryKeys.tasks.detail(blockingId ?? 'none'),
    queryFn: async (): Promise<Task | null> => {
      if (!blockingId) return null;
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('id', blockingId)
        .single();
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }
      return data as Task;
    },
    enabled: !!blockingId,
  };
}

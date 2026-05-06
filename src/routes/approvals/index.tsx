import { useState, useEffect, useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Loader2, CheckCircle, XCircle, Clock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/components/ui/utils';
import { supabase } from '@/lib/supabase';

interface Task {
  id: string;
  title: string;
  priority: string;
  assigned_to?: string | null;
  task_result?: string | null;
  last_checked_by?: string | null;
  last_checked_at?: string | null;
  working_dir?: string | null;
  claude_session_id?: string | null;
}

const priorityColors: Record<string, string> = {
  urgent: 'bg-red-100 text-red-800 border-red-200',
  high: 'bg-orange-100 text-orange-800 border-orange-200',
  medium: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  low: 'bg-gray-100 text-gray-700 border-gray-200',
};

function ApprovalsPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchApprovals = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const { data, error: dbErr } = await supabase
        .from('tasks')
        .select('id, title, priority, assigned_to, task_result, last_checked_by, last_checked_at, working_dir, claude_session_id')
        .eq('status', 'pending')
        .eq('execution_mode', 'approval_required')
        .not('task_result', 'is', null)
        .order('last_checked_at', { ascending: false })
        .limit(100);
      if (dbErr) throw new Error(dbErr.message);
      setTasks((data ?? []) as Task[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  async function handleAction(taskId: string, action: 'approve' | 'reject') {
    setActionLoading(taskId);
    try {
      const body =
        action === 'approve'
          ? { status: 'completed', execution_mode: 'report' }
          : {
              status: 'pending',
              task_result: null,
              execution_mode: 'report',
              last_checked_by: null,
              last_checked_at: null,
            };

      const { error: dbErr } = await supabase
        .from('tasks')
        .update(body)
        .eq('id', taskId);
      if (dbErr) throw new Error(dbErr.message);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch {
      alert('Action failed');
    } finally {
      setActionLoading(null);
    }
  }

  function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return 'Invalid date';
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Approvals</h1>
        <p className="text-sm text-gray-500 mt-1">
          Review agent results that require your approval
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && tasks.length === 0 && (
        <div className="rounded-lg border bg-white p-8 text-center">
          <CheckCircle className="size-8 text-green-400 mx-auto mb-3" />
          <h3 className="font-medium text-gray-900">All clear</h3>
          <p className="mt-1 text-sm text-gray-500">
            No tasks waiting for approval.
          </p>
        </div>
      )}

      {!loading && !error && tasks.length > 0 && (
        <div className="space-y-4">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="rounded-lg border border-amber-200 bg-white"
            >
              <div className="flex items-start justify-between gap-4 border-b border-amber-100 p-4">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900">{task.title}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-xs',
                        priorityColors[task.priority] ?? '',
                      )}
                    >
                      {task.priority}
                    </Badge>
                    {task.assigned_to && (
                      <span>Assigned: {task.assigned_to}</span>
                    )}
                    {task.last_checked_by && (
                      <span>Checked by: {task.last_checked_by}</span>
                    )}
                    {task.last_checked_at && (
                      <span className="flex items-center gap-1">
                        <Clock className="size-3" />
                        {formatDate(task.last_checked_at)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleAction(task.id, 'reject')}
                    disabled={actionLoading === task.id}
                    className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <XCircle className="size-4" />
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAction(task.id, 'approve')}
                    disabled={actionLoading === task.id}
                    className="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {actionLoading === task.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <CheckCircle className="size-4" />
                    )}
                    Approve
                  </button>
                </div>
              </div>

              {task.task_result && (
                <div className="p-4">
                  <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
                    <h4 className="text-xs font-semibold text-amber-800 mb-1 uppercase tracking-wide">
                      Agent Result
                    </h4>
                    <p className="whitespace-pre-wrap text-sm text-gray-700">
                      {task.task_result}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/approvals/')({
  component: ApprovalsPage,
});

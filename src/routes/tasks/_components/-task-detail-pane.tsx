import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  GitBranch,
  Loader2,
  Mail,
  Terminal,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';
import {
  blockingTaskQuery,
  subtasksQuery,
  taskDetailQuery,
  
  type TaskStatus,
} from '@/lib/queries/tasks';

import {
  assigneeIsAgent,
  autoCloseSignal,
  avatarInitial,
  dueLabel,
  isAutoClosed,
  priorityClass,
  relativeAgo,
  shortId,
  statusClass,
  type Density,
} from '../-_shared';

const STATUS_OPTIONS: TaskStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
];

interface Props {
  taskId: string;
  density?: Density;
}

export function TaskDetailPane({ taskId, density = 'full' }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: task, isLoading, error } = useQuery(taskDetailQuery(taskId));
  const { data: subtasks } = useQuery(subtasksQuery(taskId));
  const { data: blockingTask } = useQuery(
    blockingTaskQuery(task?.blocked_by_task_id ?? null),
  );

  const updateStatus = useMutation({
    mutationFn: async (status: TaskStatus) => {
      const patch: { status: TaskStatus; completed_at?: string | null } = { status };
      if (status === 'completed') patch.completed_at = new Date().toISOString();
      else if (task?.completed_at) patch.completed_at = null;
      const { error: e } = await supabase
        .from('tasks')
        .update(patch)
        .eq('id', taskId);
      if (e) throw e;
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all }),
  });

  if (isLoading) {
    return (
      <div className={cn('tk-detail-pane', `is-${density}`)}>
        <div className="tk-empty">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      </div>
    );
  }
  if (error instanceof Error) {
    return (
      <div className={cn('tk-detail-pane', `is-${density}`)}>
        <div className="tk-empty" style={{ color: 'var(--danger)', flexDirection: 'column', gap: 8 }}>
          <AlertCircle className="h-5 w-5" />
          <span>{error.message}</span>
        </div>
      </div>
    );
  }
  if (!task) {
    return (
      <div className={cn('tk-detail-pane', `is-${density}`)}>
        <div className="tk-empty">task not found</div>
      </div>
    );
  }

  const isAgent = assigneeIsAgent(task);
  const autoClosed = isAutoClosed(task);
  const signal = autoCloseSignal(task.outcome_notes);
  const due = dueLabel(task.due_date);
  const dueDate = task.due_date
    ? new Date(task.due_date).toISOString().slice(0, 10)
    : null;

  return (
    <div className={cn('tk-detail-pane', `is-${density}`)}>
      <div className="tk-det-head">
        <div className="tk-det-topline">
          <span className="id">task · {shortId(task.id)}</span>
          {density === 'full' && (
            <div className="tk-det-actions">
              <Button variant="outline" size="sm" type="button">
                Reschedule
              </Button>
              <Button variant="outline" size="sm" type="button">
                Reassign
              </Button>
              <Button
                size="sm"
                type="button"
                disabled={updateStatus.isPending || task.status === 'completed'}
                onClick={() => updateStatus.mutate('completed')}
              >
                <Check className="h-3 w-3" /> Mark complete
              </Button>
            </div>
          )}
        </div>

        <h2 className="tk-det-title">{task.title}</h2>

        <div className="tk-det-meta-row">
          <span className={cn('tk-badge', statusClass(task.status))}>
            <span className="dot" /> {task.status.replace('_', ' ')}
          </span>
          {task.assigned_to && (
            <span className={cn('tk-assignee', isAgent && 'is-agent')}>
              {isAgent ? (
                <span className="dot" />
              ) : (
                <span className="avatar">{avatarInitial(task.assigned_to)}</span>
              )}
              {task.assigned_to}
            </span>
          )}
          {task.execution_mode && (
            <span className={cn('tk-execmode', `is-${task.execution_mode}`)}>
              {task.execution_mode === 'approval_required'
                ? 'approval req'
                : task.execution_mode}
            </span>
          )}
          {task.priority && (
            <>
              <span className="sep">priority</span>
              <span className={cn('pri-label', priorityClass(task.priority))}>
                <span className="dot" />
                {task.priority}
              </span>
            </>
          )}
          {task.category && (
            <>
              <span className="sep">·</span>
              <span style={{ color: 'var(--fg-muted)' }}>{task.category}</span>
            </>
          )}
          {dueDate && (
            <>
              <span className="sep">·</span>
              <span className={cn('due-text', due.cls)}>
                due {dueDate}
                {due.cls === 'is-overdue' ? ` · ${due.label}` : ''}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="tk-det-body">
        {/* Evidence card — when auto-closed */}
        {autoClosed && task.outcome_notes && (
          <div className="tk-evidence">
            <div className="tk-evidence-head">
              <span className="rule-chip">
                <Check size={10} strokeWidth={2.5} />
                {signal ?? 'auto-closed'}
              </span>
              <span className="timestamp">{relativeAgo(task.completed_at)}</span>
            </div>
            <div className="body">{task.outcome_notes}</div>
          </div>
        )}

        {/* Source-ref row */}
        {(task.source_email_id || task.claude_session_id || task.initiative_id) && (
          <div>
            <div className="tk-section-label">
              <span>Source &amp; context</span>
              <span className="tk-deferred-pill">deferred · UI</span>
            </div>
            <div className="tk-source-row">
              {task.source_email_id && (
                <button type="button" className="tk-src is-email">
                  <Mail size={11} />
                  email · {shortId(task.source_email_id)}
                </button>
              )}
              {task.claude_session_id && (
                <button
                  type="button"
                  className="tk-src is-session"
                  onClick={() =>
                    navigate({
                      to: '/sessions/$sessionId',
                      params: { sessionId: task.claude_session_id! },
                    })
                  }
                >
                  <Terminal size={11} />
                  session · {shortId(task.claude_session_id)}
                </button>
              )}
              {task.initiative_id && (
                <button type="button" className="tk-src is-git">
                  <GitBranch size={11} />
                  initiative · {task.initiative_id}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Description */}
        {task.description && (
          <div>
            <div className="tk-section-label">
              <span>Description</span>
            </div>
            <div className="tk-desc">{task.description}</div>
          </div>
        )}

        {/* Field grid (hidden in side density) */}
        <div>
          <div className="tk-section-label">
            <span>Fields</span>
          </div>
          <dl className="tk-det-grid">
            <dt>Status</dt>
            <dd>
              <select
                value={task.status}
                disabled={updateStatus.isPending}
                onChange={(e) =>
                  updateStatus.mutate(e.target.value as TaskStatus)
                }
                style={{
                  height: 24,
                  fontSize: 11.5,
                  padding: '0 6px',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-xs)',
                  color: 'var(--fg)',
                  fontFamily: 'inherit',
                }}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </dd>
            {task.progress_pct !== null && (
              <>
                <dt>Progress</dt>
                <dd>
                  <div className="tk-progress">
                    <span style={{ width: `${task.progress_pct}%` }} />
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-muted)' }}>
                    {task.progress_pct}%
                  </span>
                </dd>
              </>
            )}
            {task.effort_estimate && (
              <>
                <dt>Effort</dt>
                <dd>
                  <code>{task.effort_estimate}</code>
                </dd>
              </>
            )}
            {task.tags && task.tags.length > 0 && (
              <>
                <dt>Tags</dt>
                <dd>
                  {task.tags.map((tag) => (
                    <span
                      key={tag}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        background: 'var(--bg-sunken)',
                        border: '1px solid var(--border-soft)',
                        color: 'var(--fg-muted)',
                        padding: '1px 6px',
                        borderRadius: 'var(--radius-xs)',
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </dd>
              </>
            )}
            {task.working_dir && (
              <>
                <dt>Working dir</dt>
                <dd>
                  <code>{task.working_dir}</code>
                </dd>
              </>
            )}
            <dt>Created</dt>
            <dd style={{ color: 'var(--fg-muted)' }}>
              {new Date(task.created_at).toLocaleString()}
              {task.agent_source && (
                <>
                  {' by '}
                  <span style={{ color: 'var(--agent)', fontFamily: 'var(--font-mono)' }}>
                    {task.agent_source}
                  </span>
                </>
              )}
            </dd>
          </dl>
        </div>

        {/* Blocked-by */}
        {blockingTask && (
          <div>
            <div className="tk-section-label">
              <span>Blocked by</span>
            </div>
            <button
              type="button"
              onClick={() =>
                navigate({
                  to: '/tasks/$taskId',
                  params: { taskId: blockingTask.id },
                })
              }
              className="tk-src"
            >
              {blockingTask.title}
            </button>
          </div>
        )}

        {/* Subtasks */}
        {subtasks && subtasks.length > 0 && (
          <div>
            <div className="tk-section-label">
              <span>Subtasks</span>
              <span className="ct">
                {subtasks.filter((s) => s.status === 'completed').length}/
                {subtasks.length}
              </span>
            </div>
            <div className="tk-subtasks">
              {subtasks.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={cn(
                    'tk-sub-row',
                    s.status === 'completed' && 'is-completed',
                  )}
                  onClick={() =>
                    navigate({
                      to: '/tasks/$taskId',
                      params: { taskId: s.id },
                    })
                  }
                >
                  <span className={cn('tk-badge', statusClass(s.status))}>
                    <span className="dot" />
                    {s.status === 'completed'
                      ? 'done'
                      : s.status === 'in_progress'
                        ? 'now'
                        : s.status.replace('_', ' ')}
                  </span>
                  <span className="name">{s.title}</span>
                  <span className="due">
                    {s.completed_at
                      ? relativeAgo(s.completed_at)
                      : s.status === 'in_progress'
                        ? 'in flight'
                        : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Activity timeline (deferred placeholder) */}
        {density !== 'side' && (
          <div>
            <div className="tk-section-label">
              <span>Activity</span>
              <span className="tk-deferred-pill">deferred · audit table</span>
            </div>
            <div className="tk-timeline">
              <div className="tk-tl-item is-mark">
                <span className="when">
                  {new Date(task.created_at).toLocaleString(undefined, {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                {task.agent_source && (
                  <span className="actor is-agent">{task.agent_source}</span>
                )}
                created
                {task.assigned_to && ` · assigned to ${task.assigned_to}`}
              </div>
              {task.completed_at && (
                <div className="tk-tl-item is-ok">
                  <span className="when">
                    {new Date(task.completed_at).toLocaleString(undefined, {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="actor">
                    {autoClosed ? 'task-health' : task.assigned_to ?? 'system'}
                  </span>
                  {autoClosed ? 'auto-closed' : 'completed'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {density !== 'full' && (
        <div className="tk-action-bar">
          <Button variant="outline" size="sm" type="button">
            Reschedule
          </Button>
          <span className="spacer" />
          <Button
            size="sm"
            type="button"
            disabled={updateStatus.isPending || task.status === 'completed'}
            onClick={() => updateStatus.mutate('completed')}
          >
            Mark complete
          </Button>
        </div>
      )}

      {updateStatus.isError && (
        <p
          style={{
            padding: '0 var(--space-5) var(--space-3)',
            fontSize: 11,
            color: 'var(--danger)',
          }}
        >
          Failed: {(updateStatus.error as Error).message}
        </p>
      )}
    </div>
  );
}

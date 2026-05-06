import { CheckCircle2 } from 'lucide-react';

import { cn } from '@/components/ui/utils';
import type { Task } from '@/lib/queries/tasks';
import {
  assigneeIsAgent,
  autoCloseSignal,
  avatarInitial,
  dueLabel,
  isAutoClosed,
  priorityClass,
  relativeAgo,
  statusClass,
} from '../-_shared';

interface Props {
  task: Task;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function TaskRow({ task, selected, onSelect }: Props) {
  const isAgent = assigneeIsAgent(task);
  const autoClosed = isAutoClosed(task);
  const due = autoClosed
    ? { label: relativeAgo(task.completed_at), cls: '' }
    : dueLabel(task.due_date);
  const signal = autoCloseSignal(task.outcome_notes);

  return (
    <button
      type="button"
      className={cn('tk-row', selected && 'is-on', autoClosed && 'is-completed')}
      onClick={() => onSelect(task.id)}
    >
      <span className={cn('pri-dot', priorityClass(task.priority))} />
      <div className="body">
        <div className="title">{task.title}</div>
        <div className="meta">
          <span className={cn('tk-badge', statusClass(task.status))}>
            <span className="dot" />
            {task.status.replace('_', ' ')}
          </span>
          {autoClosed && signal && (
            <span className="tk-autoclose">
              <CheckCircle2 size={9} strokeWidth={2.5} />
              {signal}
            </span>
          )}
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
          {task.category && <span className="cat">{task.category}</span>}
          {task.execution_mode && (
            <span className={cn('tk-execmode', `is-${task.execution_mode}`)}>
              {task.execution_mode === 'approval_required'
                ? 'approval req'
                : task.execution_mode}
            </span>
          )}
        </div>
      </div>
      <div className="right">
        <span className={cn('due', due.cls)}>{due.label}</span>
      </div>
    </button>
  );
}

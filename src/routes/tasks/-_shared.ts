import type { Task, TaskPriority, TaskStatus } from '@/lib/queries/tasks';

export type Density = 'full' | 'compact' | 'side';

export type GroupKey = 'overdue' | 'today' | 'week' | 'later' | 'autoclosed';

export interface TaskGroup {
  key: GroupKey;
  label: string;
  tasks: Task[];
}

const ONE_DAY = 24 * 60 * 60 * 1000;

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function groupTasks(tasks: Task[], showAutoclosed: boolean): TaskGroup[] {
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = new Date(today.getTime() + ONE_DAY);
  const weekEnd = new Date(today.getTime() + 7 * ONE_DAY);

  const overdue: Task[] = [];
  const todayG: Task[] = [];
  const week: Task[] = [];
  const later: Task[] = [];
  const autoclosed: Task[] = [];

  for (const t of tasks) {
    const isAutoClosed =
      t.status === 'completed' &&
      t.outcome_notes?.startsWith('Auto-closed by task-health');
    if (isAutoClosed) {
      if (showAutoclosed) autoclosed.push(t);
      continue;
    }
    if (t.status === 'completed' || t.status === 'cancelled') continue;
    const due = t.due_date ? new Date(t.due_date) : null;
    if (!due) {
      later.push(t);
      continue;
    }
    if (due < today) overdue.push(t);
    else if (due < tomorrow) todayG.push(t);
    else if (due < weekEnd) week.push(t);
    else later.push(t);
  }

  const out: TaskGroup[] = [];
  if (overdue.length) out.push({ key: 'overdue', label: 'Overdue', tasks: overdue });
  if (todayG.length) out.push({ key: 'today', label: 'Today', tasks: todayG });
  if (week.length) out.push({ key: 'week', label: 'This week', tasks: week });
  if (later.length) out.push({ key: 'later', label: 'Later', tasks: later });
  if (autoclosed.length)
    out.push({ key: 'autoclosed', label: 'Auto-closed', tasks: autoclosed });
  return out;
}

export function priorityClass(p: TaskPriority | null | undefined): string {
  if (!p) return 'is-low';
  return `is-${p}`;
}

export function statusClass(s: TaskStatus): string {
  return `is-${s}`;
}

export function dueLabel(d: string | null): { label: string; cls: string } {
  if (!d) return { label: '—', cls: '' };
  const due = new Date(d);
  const now = new Date();
  const today = startOfDay(now);
  const dueDay = startOfDay(due);
  const dayDiff = Math.round((dueDay.getTime() - today.getTime()) / ONE_DAY);

  if (dueDay.getTime() < today.getTime()) {
    const overdueDays = Math.abs(dayDiff);
    return {
      label: overdueDays === 0 ? 'overdue' : `${overdueDays}d overdue`,
      cls: 'is-overdue',
    };
  }
  if (dayDiff === 0) {
    const hh = String(due.getHours()).padStart(2, '0');
    const mm = String(due.getMinutes()).padStart(2, '0');
    return { label: `today · ${hh}:${mm}`, cls: 'is-today' };
  }
  if (dayDiff < 7) {
    return {
      label: due.toLocaleDateString(undefined, { weekday: 'short' }),
      cls: '',
    };
  }
  return {
    label: due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    cls: '',
  };
}

export function relativeAgo(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function isAutoClosed(t: Pick<Task, 'status' | 'outcome_notes'>): boolean {
  return (
    t.status === 'completed' &&
    !!t.outcome_notes &&
    t.outcome_notes.startsWith('Auto-closed by task-health')
  );
}

export function autoCloseSignal(notes: string | null): string | null {
  if (!notes) return null;
  if (!notes.startsWith('Auto-closed by task-health')) return null;
  // "Auto-closed by task-health: email_draft 4f12 sent ..."
  const lower = notes.toLowerCase();
  if (lower.includes('email_draft')) return 'email-sent';
  if (lower.includes('social_queue')) return 'social-posted';
  if (lower.includes('blog')) return 'blog-published';
  if (lower.includes('commit')) return 'git-commit';
  if (lower.includes('deal')) return 'deal-closed';
  return 'auto-closed';
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function assigneeIsAgent(t: Task): boolean {
  if (t.assignee_type === 'agent') return true;
  if (t.assignee_type === 'human') return false;
  return !!(t.assigned_to && t.assigned_to.endsWith('-agent'));
}

export function avatarInitial(name: string | null): string {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

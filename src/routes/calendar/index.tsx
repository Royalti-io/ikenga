import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Calendar as CalendarIcon,
  AlertCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

import { cn } from '@/components/ui/utils';
import {
  calendarWeekQuery,
  formatDateKey,
  getWeekStart,
  type CalendarEvent,
} from '@/lib/queries/calendar';

const DAYS_OF_WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function formatTimeRange(ev: CalendarEvent): string {
  const start = new Date(ev.start_time);
  const end = new Date(ev.end_time);
  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function CalendarPage() {
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const days = useMemo(() => weekDays(weekStart), [weekStart]);

  const { data, isLoading, error } = useQuery(calendarWeekQuery(weekStart));

  const todayKey = formatDateKey(new Date());
  const todayEvents = data?.byDate[todayKey] ?? [];

  const totalEvents = data?.events.length ?? 0;
  const remindersSent = data?.events.filter((e) => e.reminder_sent).length ?? 0;

  function shiftWeek(deltaDays: number) {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + deltaDays);
    setWeekStart(getWeekStart(next));
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarIcon className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Calendar</h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => shiftWeek(-7)}
              className="rounded-md border border-input p-1 text-muted-foreground hover:bg-accent"
              aria-label="Previous week"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => setWeekStart(getWeekStart(new Date()))}
              className="rounded-md border border-input px-3 py-1 text-xs font-medium hover:bg-accent"
            >
              Today
            </button>
            <button
              onClick={() => shiftWeek(7)}
              className="rounded-md border border-input p-1 text-muted-foreground hover:bg-accent"
              aria-label="Next week"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Week of {weekStart.toLocaleDateString()} —{' '}
          {totalEvents} event{totalEvents === 1 ? '' : 's'}
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {error instanceof Error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load calendar</p>
              <p className="text-xs opacity-80">{error.message}</p>
            </div>
          </div>
        )}

        {data && (
          <>
            {/* Stat cards */}
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-2xl font-bold">{totalEvents}</div>
                <div className="text-xs text-muted-foreground">This week</div>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-2xl font-bold text-blue-600">
                  {todayEvents.length}
                </div>
                <div className="text-xs text-muted-foreground">Today</div>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-2xl font-bold text-emerald-600">
                  {remindersSent}
                </div>
                <div className="text-xs text-muted-foreground">
                  Reminders sent
                </div>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-2xl font-bold text-amber-600">
                  {totalEvents - remindersSent}
                </div>
                <div className="text-xs text-muted-foreground">
                  Pending reminders
                </div>
              </div>
            </div>

            {/* Today section */}
            {todayEvents.length > 0 && (
              <section className="mb-4">
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Today
                </h2>
                <ul className="overflow-hidden rounded-lg border border-border">
                  {todayEvents.map((ev) => (
                    <li
                      key={ev.id}
                      className="border-b border-border px-3 py-2 last:border-b-0"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{ev.title}</div>
                          {ev.description && (
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {ev.description}
                            </p>
                          )}
                          {ev.location && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {ev.location}
                            </p>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatTimeRange(ev)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Week grid */}
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Week
            </h2>
            <div className="grid grid-cols-7 gap-2">
              {days.map((d, i) => {
                const key = formatDateKey(d);
                const dayEvents = data.byDate[key] ?? [];
                const isToday = key === todayKey;
                return (
                  <div
                    key={key}
                    className={cn(
                      'rounded-lg border border-border bg-card p-2 min-h-[8rem]',
                      isToday && 'border-primary',
                    )}
                  >
                    <div className="mb-1 flex items-baseline justify-between">
                      <div
                        className={cn(
                          'text-xs uppercase tracking-wide',
                          isToday ? 'text-primary font-medium' : 'text-muted-foreground',
                        )}
                      >
                        {DAYS_OF_WEEK[i]}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {d.getDate()}
                      </div>
                    </div>
                    {dayEvents.length === 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground/60">—</p>
                    ) : (
                      <ul className="space-y-1">
                        {dayEvents.map((ev) => (
                          <li
                            key={ev.id}
                            className="rounded-md bg-accent/40 px-2 py-1 text-xs"
                          >
                            <div
                              className="truncate font-medium"
                              title={ev.title}
                            >
                              {ev.title}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {formatTimeRange(ev)}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/calendar/')({
  component: CalendarPage,
});

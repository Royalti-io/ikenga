import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';

export interface CalendarEvent {
  id: string;
  google_event_id: string | null;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  location: string | null;
  reminder_sent: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

export function getWeekStart(d: Date): Date {
  const result = new Date(d);
  const day = result.getDay();
  // Use Monday as start of week.
  const diff = (day === 0 ? -6 : 1) - day;
  result.setDate(result.getDate() + diff);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function getWeekEnd(weekStart: Date): Date {
  const result = new Date(weekStart);
  result.setDate(result.getDate() + 6);
  result.setHours(23, 59, 59, 999);
  return result;
}

export function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function calendarWeekQuery(weekStart: Date) {
  const start = formatDateKey(weekStart);
  const end = formatDateKey(getWeekEnd(weekStart));
  return {
    queryKey: queryKeys.calendar.week(start, end),
    queryFn: async (): Promise<{
      events: CalendarEvent[];
      byDate: Record<string, CalendarEvent[]>;
      weekStart: string;
      weekEnd: string;
    }> => {
      const { data, error } = await supabase
        .from('calendar_events')
        .select('*')
        .gte('start_time', `${start}T00:00:00`)
        .lt('start_time', `${end}T23:59:59`)
        .order('start_time', { ascending: true });
      if (error) throw error;
      const events = (data ?? []) as CalendarEvent[];
      const byDate: Record<string, CalendarEvent[]> = {};
      for (const ev of events) {
        const key = ev.start_time.split('T')[0];
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push(ev);
      }
      return { events, byDate, weekStart: start, weekEnd: end };
    },
  };
}

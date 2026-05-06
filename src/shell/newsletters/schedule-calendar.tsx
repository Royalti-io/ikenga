import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { newsletterDraftsListQuery } from '@/lib/queries/email-drafts';
import { queryKeys } from '@/lib/query-keys';

const LAGOS_OFFSET_HOURS = 1;
const MS_PER_DAY = 86_400_000;

interface SentRow {
  id: string;
  draft_slug: string | null;
  edition: string | null;
  subject: string | null;
  delivery_system: string | null;
  sent_at: string | null;
}

function startOfWeekLagos(d: Date): Date {
  // Convert to Lagos wall-clock, then snap to Monday 00:00 Lagos.
  const lagos = new Date(d.getTime() + LAGOS_OFFSET_HOURS * 3600_000);
  const dow = lagos.getUTCDay(); // 0 = Sun
  const monIdx = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(
    Date.UTC(
      lagos.getUTCFullYear(),
      lagos.getUTCMonth(),
      lagos.getUTCDate() + monIdx,
      0,
      0,
      0,
      0,
    ),
  );
  // Convert back to UTC: subtract Lagos offset.
  return new Date(monday.getTime() - LAGOS_OFFSET_HOURS * 3600_000);
}

function lagosDayKey(d: Date): string {
  const lagos = new Date(d.getTime() + LAGOS_OFFSET_HOURS * 3600_000);
  return `${lagos.getUTCFullYear()}-${String(lagos.getUTCMonth() + 1).padStart(2, '0')}-${String(lagos.getUTCDate()).padStart(2, '0')}`;
}

function lagosTimeLabel(iso: string): string {
  const d = new Date(iso);
  const lagos = new Date(d.getTime() + LAGOS_OFFSET_HOURS * 3600_000);
  const h = lagos.getUTCHours();
  const m = lagos.getUTCMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function lagosDayNum(d: Date): number {
  const lagos = new Date(d.getTime() + LAGOS_OFFSET_HOURS * 3600_000);
  return lagos.getUTCDate();
}

function isSameLagosDay(a: Date, b: Date): boolean {
  return lagosDayKey(a) === lagosDayKey(b);
}

interface PillData {
  id: string;
  type: 'newsletter' | 'investor_update' | 'sent';
  state: 'approved' | 'cooling' | 'pending' | 'sent';
  subject: string;
  scheduledFor: string;
  draftId?: string;
}

function pillClass(p: PillData): string {
  if (p.state === 'sent') return 'nl-cal-pill sent';
  if (p.state === 'cooling') return 'nl-cal-pill cool';
  if (p.type === 'investor_update') return 'nl-cal-pill investor';
  return 'nl-cal-pill';
}

interface Props {
  onPillClick?: (p: PillData) => void;
}

export function ScheduleCalendar({ onPillClick }: Props) {
  const now = new Date();
  const weekStart = startOfWeekLagos(now);
  // Show last week (-1) and this week (0) by default — past 2 weeks of sends
  // contextualise the upcoming slot.
  const startDate = new Date(weekStart.getTime() - 7 * MS_PER_DAY);
  const endDate = new Date(weekStart.getTime() + 14 * MS_PER_DAY);

  const draftsQ = useQuery(
    newsletterDraftsListQuery({
      statuses: ['draft', 'pending_review', 'approved'],
    }),
  );
  const sentQ = useQuery({
    queryKey: [...queryKeys.newsletterSends.all, 'calendar', startDate.toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('newsletter_sends')
        .select('id, draft_slug, edition, subject, delivery_system, sent_at')
        .gte('sent_at', startDate.toISOString())
        .lte('sent_at', endDate.toISOString())
        .order('sent_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SentRow[];
    },
  });

  const drafts = draftsQ.data ?? [];
  const sends = sentQ.data ?? [];

  const pillsByDay = new Map<string, PillData[]>();
  for (const d of drafts) {
    if (!d.scheduled_for) continue;
    const when = new Date(d.scheduled_for);
    if (when < startDate || when >= endDate) continue;
    const cooling =
      d.reviewable_after && new Date(d.reviewable_after) > now ? true : false;
    const p: PillData = {
      id: `draft:${d.id}`,
      type: d.type === 'investor_update' ? 'investor_update' : 'newsletter',
      state: cooling
        ? 'cooling'
        : d.status === 'approved'
          ? 'approved'
          : 'pending',
      subject: d.subject,
      scheduledFor: d.scheduled_for,
      draftId: d.id,
    };
    const key = lagosDayKey(when);
    pillsByDay.set(key, [...(pillsByDay.get(key) ?? []), p]);
  }
  for (const s of sends) {
    if (!s.sent_at) continue;
    const when = new Date(s.sent_at);
    const p: PillData = {
      id: `sent:${s.id}`,
      type: 'sent',
      state: 'sent',
      subject: s.subject ?? s.edition ?? 'Sent edition',
      scheduledFor: s.sent_at,
    };
    const key = lagosDayKey(when);
    pillsByDay.set(key, [...(pillsByDay.get(key) ?? []), p]);
  }

  // Build 3 weeks: prev, current, next.
  const weeks = [-1, 0, 1].map((w) => {
    const wkStart = new Date(weekStart.getTime() + w * 7 * MS_PER_DAY);
    const days = Array.from({ length: 7 }, (_, i) => new Date(wkStart.getTime() + i * MS_PER_DAY));
    return { wkStart, days, label: weekLabel(wkStart, w) };
  });

  return (
    <div className="nl-cal-wrap">
      {/* Header row (one for the whole table) */}
      <div className="nl-cal-week head">
        <div className="nl-cal-cell label">Week</div>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => {
          const day = new Date(weekStart.getTime() + i * MS_PER_DAY);
          const isToday = isSameLagosDay(day, now);
          return (
            <div
              key={label}
              className={`nl-cal-cell${isToday ? ' is-today' : ''}`}
            >
              {label}
            </div>
          );
        })}
      </div>

      {weeks.map(({ days, label }) => (
        <div key={label} className="nl-cal-week">
          <div className="nl-cal-cell label">{label}</div>
          {days.map((day) => {
            const isToday = isSameLagosDay(day, now);
            const pills = pillsByDay.get(lagosDayKey(day)) ?? [];
            return (
              <div
                key={day.toISOString()}
                className={`nl-cal-cell${isToday ? ' is-today' : ''}`}
              >
                <div className="nl-cal-day-num">
                  {String(lagosDayNum(day)).padStart(2, '0')}
                  {isToday ? ' · today' : ''}
                </div>
                {pills.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={pillClass(p)}
                    onClick={() => onPillClick?.(p)}
                    title={`${lagosTimeLabel(p.scheduledFor)} · ${p.subject}`}
                  >
                    <span className="ptime">{lagosTimeLabel(p.scheduledFor)}</span>
                    {p.subject}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ))}

      <div className="nl-cal-legend">
        <span>
          <span
            className="swatch"
            style={{
              background: 'color-mix(in srgb, var(--tint-fg-active, var(--primary)) 14%, var(--bg-surface))',
              borderColor: 'color-mix(in srgb, var(--tint-fg-active, var(--primary)) 30%, var(--border))',
            }}
          />
          Newsletter (approved / pending)
        </span>
        <span>
          <span
            className="swatch"
            style={{
              background: 'color-mix(in srgb, hsl(38, 75%, 50%) 14%, var(--bg-surface))',
              borderColor: 'hsl(38, 50%, 30%)',
            }}
          />
          Cooling
        </span>
        <span>
          <span
            className="swatch"
            style={{
              background: 'color-mix(in srgb, hsl(150, 50%, 50%) 14%, var(--bg-surface))',
              borderColor: 'hsl(150, 35%, 30%)',
            }}
          />
          Investor update
        </span>
        <span>
          <span
            className="swatch"
            style={{ background: 'var(--bg-base)', borderColor: 'var(--border)', borderStyle: 'dashed' }}
          />
          Sent
        </span>
        <span style={{ marginLeft: 'auto' }}>Lagos time · drag-to-reschedule TK</span>
      </div>
    </div>
  );
}

function weekLabel(wkStart: Date, offset: number): string {
  const lagos = new Date(wkStart.getTime() + LAGOS_OFFSET_HOURS * 3600_000);
  const month = lagos.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const dayNum = String(lagos.getUTCDate()).padStart(2, '0');
  const tag =
    offset === -1 ? 'last' : offset === 0 ? 'this week' : 'next week';
  return `${dayNum} ${month} · ${tag}`;
}

export type { PillData };
export { lagosTimeLabel };

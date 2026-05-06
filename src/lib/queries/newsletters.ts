import { queryOptions } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';

export interface NewsletterSend {
  id: string;
  draft_slug: string;
  edition: string | null;
  subject: string | null;
  subject_alt: string | null;
  delivery_system: string | null;
  campaign_id: string | null;
  sent_at: string | null;
  recipient_count: number | null;
  open_rate: number | null;
  click_rate: number | null;
  opens_count: number | null;
  clicks_count: number | null;
  bounces_count: number | null;
  complaints_count: number | null;
  bounce_rate: number | null;
  complaint_rate: number | null;
  stats_url: string | null;
}

export interface NewsletterStatsPoint {
  id: string;
  campaignId: string | null;
  sentAt: string;
  edition: string;
  subject: string;
  deliverySystem: 'listmonk' | 'resend' | 'smtp' | 'unknown';
  recipients: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
  complaintRate: number;
  draftType: 'newsletter' | 'investor_update' | 'unknown';
}

export function newsletterSendsListQuery() {
  return queryOptions({
    queryKey: queryKeys.newsletterSends.list(),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('newsletter_sends')
        .select('*')
        .order('sent_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as NewsletterSend[];
    },
  });
}

// Aggregate stats for the Sent · Charts view. Returns one row per send,
// joined to email_drafts for the type field. We intentionally re-shape into
// camelCase points so the chart components don't need to know about the
// snake_case wire format.
export function newsletterStatsQuery({ days = 90 }: { days?: number } = {}) {
  return queryOptions({
    queryKey: ['newsletter_stats', days] as const,
    queryFn: async (): Promise<NewsletterStatsPoint[]> => {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('newsletter_sends')
        .select(
          'id, campaign_id, sent_at, edition, subject, delivery_system, recipient_count, open_rate, click_rate, bounce_rate, complaint_rate, draft_slug, draft:email_drafts!newsletter_sends_draft_slug_fkey(type)',
        )
        .gte('sent_at', since)
        .order('sent_at', { ascending: true });
      if (error) {
        // Fallback without join when the FK isn't named as expected on prod.
        const { data: bare, error: bareErr } = await supabase
          .from('newsletter_sends')
          .select(
            'id, campaign_id, sent_at, edition, subject, delivery_system, recipient_count, open_rate, click_rate, bounce_rate, complaint_rate',
          )
          .gte('sent_at', since)
          .order('sent_at', { ascending: true });
        if (bareErr) throw bareErr;
        return (bare ?? [])
          .filter((r) => r.sent_at)
          .map((r) => normalisePoint(r as Record<string, unknown>));
      }
      return (data ?? [])
        .filter((r) => r.sent_at)
        .map((r) => normalisePoint(r as Record<string, unknown>));
    },
  });
}

function normalisePoint(r: Record<string, unknown>): NewsletterStatsPoint {
  const draft = r.draft as { type?: string } | null | undefined;
  const sys = (r.delivery_system as string | null) ?? 'unknown';
  return {
    id: String(r.id),
    campaignId: (r.campaign_id as string | null) ?? null,
    sentAt: r.sent_at as string,
    edition: (r.edition as string | null) ?? '',
    subject: (r.subject as string | null) ?? '',
    deliverySystem: ['listmonk', 'resend', 'smtp'].includes(sys)
      ? (sys as 'listmonk' | 'resend' | 'smtp')
      : 'unknown',
    recipients: Number(r.recipient_count ?? 0),
    openRate: Number(r.open_rate ?? 0),
    clickRate: Number(r.click_rate ?? 0),
    bounceRate: Number(r.bounce_rate ?? 0),
    complaintRate: Number(r.complaint_rate ?? 0),
    draftType:
      draft?.type === 'newsletter' || draft?.type === 'investor_update'
        ? draft.type
        : 'unknown',
  };
}

export function newsletterBadgeQuery() {
  return queryOptions({
    queryKey: ['newsletter_badge'] as const,
    queryFn: async () => {
      const nowIso = new Date().toISOString();
      const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const [drafts, sends] = await Promise.all([
        supabase
          .from('email_drafts')
          .select('id, status, scheduled_for, reviewable_after')
          .in('type', ['newsletter', 'investor_update'])
          .in('status', ['draft', 'pending_review', 'approved']),
        supabase
          .from('newsletter_sends')
          .select('bounce_rate, complaint_rate, sent_at')
          .gte('sent_at', since30),
      ]);
      const rows = drafts.data ?? [];
      const sendRows = sends.data ?? [];
      const ready = rows.filter(
        (r) =>
          (r.status === 'draft' || r.status === 'pending_review') &&
          (!r.reviewable_after || r.reviewable_after <= nowIso),
      );
      const cooling = rows.filter(
        (r) =>
          (r.status === 'draft' || r.status === 'pending_review') &&
          r.reviewable_after &&
          r.reviewable_after > nowIso,
      );
      const scheduled = rows.filter(
        (r) => r.status === 'approved' && r.scheduled_for,
      );
      const nextReadyAt = cooling
        .map((r) => r.reviewable_after as string)
        .sort()[0] ?? null;
      const alerts30d = sendRows.filter(
        (s) =>
          (s.bounce_rate ?? 0) > 0.02 || (s.complaint_rate ?? 0) > 0.001,
      ).length;
      return {
        ready: ready.length,
        cooling: cooling.length,
        nextReadyAt,
        scheduled: scheduled.length,
        alerts30d,
      };
    },
    staleTime: 30_000,
  });
}

import { useMemo } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2, Mail, Newspaper, Share2 } from 'lucide-react';
import { z } from 'zod';

import { supabase } from '@/lib/supabase';
import { newsletterSendsListQuery } from '@/lib/queries/newsletters';

type SentType = 'email' | 'newsletter' | 'social';

interface UnifiedSentItem {
  id: string;
  type: SentType;
  title: string;
  subtitle?: string | null;
  channel?: string | null;
  recipientCount?: number | null;
  sentAt: string;
  meta?: string | null;
}

const FILTER_CHIPS: Array<{ value: SentType | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'email', label: 'Email' },
  { value: 'newsletter', label: 'Newsletter' },
  { value: 'social', label: 'Social' },
];

const typeIcon: Record<SentType, typeof Mail> = {
  email: Mail,
  newsletter: Newspaper,
  social: Share2,
};

const searchSchema = z.object({
  type: z.enum(['all', 'email', 'newsletter', 'social']).optional(),
});

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatPct(value: number | null | undefined): string {
  if (value == null) return '';
  return `${(value * 100).toFixed(1)}%`;
}

interface SentEmailRow {
  id: string;
  subject: string;
  from_email: string;
  delivery_system: string;
  type: string;
  sent_at: string | null;
  created_at: string;
}

function sentEmailsQuery() {
  return {
    queryKey: ['outbox-sent', 'emails'] as const,
    queryFn: async (): Promise<SentEmailRow[]> => {
      const { data, error } = await supabase
        .from('email_drafts')
        .select('id, subject, from_email, delivery_system, type, sent_at, created_at')
        .eq('status', 'sent')
        .neq('type', 'newsletter')
        .neq('type', 'investor_update')
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as SentEmailRow[];
    },
  };
}

interface PostedSocialRow {
  id: string;
  platform: string;
  account: string;
  content: string;
  posted_at: string | null;
  created_at: string;
  post_url: string | null;
}

function postedSocialQuery() {
  return {
    queryKey: ['outbox-sent', 'social'] as const,
    queryFn: async (): Promise<PostedSocialRow[]> => {
      const { data, error } = await supabase
        .from('social_queue')
        .select('id, platform, account, content, posted_at, created_at, post_url')
        .eq('status', 'posted')
        .order('posted_at', { ascending: false, nullsFirst: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as PostedSocialRow[];
    },
  };
}

function OutboxSentPage() {
  const { type: typeParam } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const activeType = typeParam ?? 'all';

  const emails = useQuery(sentEmailsQuery());
  const newsletters = useQuery(newsletterSendsListQuery());
  const social = useQuery(postedSocialQuery());

  const isLoading = emails.isLoading || newsletters.isLoading || social.isLoading;
  const firstError = emails.error || newsletters.error || social.error;

  const unified = useMemo<UnifiedSentItem[]>(() => {
    const out: UnifiedSentItem[] = [];

    for (const e of emails.data ?? []) {
      out.push({
        id: `email:${e.id}`,
        type: 'email',
        title: e.subject || '(no subject)',
        subtitle: e.from_email,
        channel: e.delivery_system,
        sentAt: e.sent_at ?? e.created_at,
      });
    }
    for (const n of newsletters.data ?? []) {
      out.push({
        id: `newsletter:${n.id}`,
        type: 'newsletter',
        title: n.subject || n.edition || n.draft_slug,
        subtitle: n.edition ? `Edition · ${n.edition}` : n.draft_slug,
        channel: n.delivery_system ?? null,
        recipientCount: n.recipient_count,
        sentAt: n.sent_at ?? '',
        meta: [
          formatPct(n.open_rate) && `${formatPct(n.open_rate)} open`,
          formatPct(n.click_rate) && `${formatPct(n.click_rate)} click`,
        ]
          .filter(Boolean)
          .join(' · '),
      });
    }
    for (const s of social.data ?? []) {
      out.push({
        id: `social:${s.id}`,
        type: 'social',
        title: s.content.slice(0, 100) + (s.content.length > 100 ? '…' : ''),
        subtitle: s.account,
        channel: s.platform,
        sentAt: s.posted_at ?? s.created_at,
      });
    }

    out.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
    return activeType === 'all' ? out : out.filter((item) => item.type === activeType);
  }, [emails.data, newsletters.data, social.data, activeType]);

  const counts = useMemo(() => {
    return {
      all:
        (emails.data?.length ?? 0) +
        (newsletters.data?.length ?? 0) +
        (social.data?.length ?? 0),
      email: emails.data?.length ?? 0,
      newsletter: newsletters.data?.length ?? 0,
      social: social.data?.length ?? 0,
    };
  }, [emails.data, newsletters.data, social.data]);

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div className="ob-frame">
        <div className="ob-frame-head">
          <div className="ob-frame-dot" />
          <div className="ob-frame-title">/outbox/sent · unified history</div>
          <div className="ob-frame-meta">
            filter: {activeType} · {unified.length} items
          </div>
        </div>

        <div className="ob-filter-strip">
          {FILTER_CHIPS.map((chip) => {
            const isActive = activeType === chip.value;
            const count = counts[chip.value] ?? 0;
            return (
              <button
                key={chip.value}
                type="button"
                className={`ob-filter-chip${isActive ? ' is-on' : ''}`}
                onClick={() =>
                  navigate({
                    search: chip.value === 'all' ? {} : { type: chip.value },
                  })
                }
              >
                {chip.label} · {count}
              </button>
            );
          })}
          <span style={{ flex: 1 }} />
          {activeType !== 'all' && (
            <ChannelChartsDeeplink type={activeType} />
          )}
        </div>

        {isLoading && (
          <div className="ob-loading">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span style={{ marginLeft: 8 }}>Loading…</span>
          </div>
        )}

        {firstError instanceof Error && (
          <div
            style={{
              margin: 'var(--space-3)',
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-sm)',
              background: 'color-mix(in srgb, var(--danger) 10%, var(--bg-sunken))',
              color: 'var(--danger)',
              fontSize: 'var(--text-body-sm)',
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
            }}
          >
            <AlertCircle aria-hidden style={{ flexShrink: 0, marginTop: 2, width: 14, height: 14 }} />
            <div>
              <p style={{ margin: 0, fontWeight: 500 }}>Failed to load sent items</p>
              <p style={{ margin: 0, opacity: 0.8, fontSize: 11 }}>{firstError.message}</p>
            </div>
          </div>
        )}

        {!isLoading && unified.length === 0 && !firstError && (
          <div className="ob-empty">
            <h3>Nothing sent yet</h3>
            <p>Approved drafts move here once their provider confirms delivery.</p>
          </div>
        )}

        {unified.length > 0 && (
          <div>
            {unified.map((item) => {
              const Icon = typeIcon[item.type];
              const channelChipClass =
                item.type === 'email'
                  ? `ob-chip-${(item.channel ?? '').toLowerCase()}`
                  : item.type === 'newsletter'
                    ? 'ob-chip-listmonk'
                    : `ob-chip-${(item.channel ?? '').toLowerCase()}`;
              return (
                <div key={item.id} className="ob-sent-row">
                  <div className="ob-sent-icon">
                    <Icon aria-hidden />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="ob-row-title" title={item.title}>
                      {item.title}
                    </div>
                    <div className="ob-row-sub">
                      {item.subtitle}
                      {item.channel && (
                        <span
                          className={`ob-chip ${channelChipClass}`}
                          style={{ marginLeft: 8 }}
                        >
                          {item.channel}
                        </span>
                      )}
                      {item.recipientCount != null && (
                        <span style={{ marginLeft: 8 }}>
                          · {item.recipientCount.toLocaleString()} recipients
                        </span>
                      )}
                      {item.meta && <span style={{ marginLeft: 8 }}>· {item.meta}</span>}
                    </div>
                  </div>
                  <div className="ob-row-meta">
                    {item.sentAt ? formatDate(item.sentAt) : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelChartsDeeplink({ type }: { type: SentType }) {
  // Only the newsletter sub-app has a built-out charts view today. For
  // email/social the deeplink is hidden until those views ship.
  if (type !== 'newsletter') return null;
  return (
    <Link
      to="/outbox/newsletter/sent"
      search={{ view: 'charts' as const }}
      title="Open the Charts view scoped to newsletter sends"
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        letterSpacing: '.04em',
        color: 'var(--tint-fg-active, var(--primary))',
        border:
          '1px solid color-mix(in srgb, var(--tint-fg-active, var(--primary)) 30%, var(--border))',
        borderRadius: 'var(--radius-pill)',
        padding: '3px var(--space-2)',
        textDecoration: 'none',
      }}
    >
      ↗ Charts for newsletter
    </Link>
  );
}

export const Route = createFileRoute('/outbox/sent/')({
  validateSearch: searchSchema,
  component: OutboxSentPage,
});

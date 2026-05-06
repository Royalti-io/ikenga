import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  AlertCircle,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  Send,
  XCircle,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/query-keys';
import {
  socialQueueDraftsQuery,
  type SocialQueueItem,
} from '@/lib/queries/social-posts';
import { HandoffButtons } from '@/routes/outbox/-components/handoff-buttons';

// Per-platform character limits (screen 13 §B). Soft caps for LI / IG; hard
// caps for X and BS.
const PLATFORM_LIMIT: Record<string, number> = {
  linkedin: 3000,
  twitter: 280,
  x: 280,
  bluesky: 300,
  bs: 300,
  instagram: 2200,
  facebook: 63206,
};

const PLATFORM_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  twitter: 'X',
  x: 'X',
  bluesky: 'Bluesky',
  bs: 'Bluesky',
  instagram: 'Instagram',
  facebook: 'Facebook',
};

const PLATFORM_PILL: Record<string, string> = {
  linkedin: 'plat-li',
  twitter: 'plat-x',
  x: 'plat-x',
  bluesky: 'plat-bs',
  bs: 'plat-bs',
  facebook: 'plat-fb',
  instagram: 'plat-ig',
};

const PLATFORM_HANDLE: Record<string, string> = {
  linkedin: 'Royalti.io',
  twitter: '@royalti',
  x: '@royalti',
  bluesky: '@royalti.io',
  facebook: 'Royalti.io',
  instagram: '@royalti',
};

const REJECT_REASONS = [
  'Tone is off',
  'Off-message',
  'Wrong angle',
  "Image doesn't match",
  'Missing context',
];

// NOTE: screen 13 §B/C describe per-platform fan-out (one post → N rows
// sharing a group_id, per-platform reject). The current social_queue
// schema (migration 028) has no group_id column and no 'rejected' status,
// so this implementation ships single-row queue: one row = one platform,
// approve/reject is per-row. Per user decision; flag for follow-up
// migration if fan-out earns its keep.

type GroupKey = 'blog' | 'agent' | 'manual' | 'reply';
const GROUP_LABEL: Record<GroupKey, string> = {
  blog: 'Blog announcement',
  agent: 'AI generation',
  manual: 'Manual',
  reply: 'Reply',
};
const GROUP_ORDER: GroupKey[] = ['blog', 'agent', 'manual', 'reply'];

function inferGroup(item: SocialQueueItem): GroupKey {
  if (item.source === 'blog-pipeline') return 'blog';
  if (item.source === 'cmo-cycle') return 'agent';
  if (item.source === 'manual') return 'manual';
  return 'agent';
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const delta = Date.now() - t;
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function platformKey(p: string): string {
  return p.toLowerCase().trim();
}

interface SocialQueuePageProps {
  postId?: string;
}

export function SocialQueuePage({ postId }: SocialQueuePageProps = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery(socialQueueDraftsQuery());
  const posts = useMemo(() => data ?? [], [data]);

  const groups = useMemo(() => {
    const out: Record<GroupKey, SocialQueueItem[]> = {
      blog: [], agent: [], manual: [], reply: [],
    };
    for (const p of posts) {
      out[inferGroup(p)].push(p);
    }
    return out;
  }, [posts]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    if (posts.length === 0) return;
    initRef.current = true;
    if (postId && posts.some((p) => p.id === postId)) {
      setSelectedId(postId);
      return;
    }
    setSelectedId(posts[0]?.id ?? null);
  }, [posts, postId]);
  useEffect(() => {
    if (selectedId && posts.some((p) => p.id === selectedId)) return;
    setSelectedId(posts[0]?.id ?? null);
  }, [posts, selectedId]);

  function selectPost(id: string) {
    setSelectedId(id);
    navigate({
      to: '/outbox/social/queue',
      search: (prev: Record<string, unknown>) => ({ ...prev, post: id }),
      replace: true,
    });
  }

  const selected = selectedId
    ? posts.find((p) => p.id === selectedId) ?? null
    : null;

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--fg-muted)' }}>
        <Loader2 className="animate-spin" style={{ width: 16, height: 16 }} aria-hidden />
      </div>
    );
  }
  if (error instanceof Error) {
    return (
      <div className="ob-error" style={{ margin: 'var(--space-3)' }}>
        <AlertCircle aria-hidden style={{ width: 14, height: 14 }} />
        Failed to load social posts: {error.message}
      </div>
    );
  }
  if (posts.length === 0) {
    return (
      <div className="ob-empty" style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
        <h3>Nothing in review</h3>
        <p>cmo-agent runs draft posts on a schedule. Or compose now (⌘⇧N) for a one-off.</p>
      </div>
    );
  }

  return (
    <div className="nl-split so-md">
      <div className="nl-master so-master">
        {GROUP_ORDER.map((key) => {
          const list = groups[key];
          if (list.length === 0) return null;
          return (
            <div key={key}>
              <div className="nl-master-group-head">
                {GROUP_LABEL[key]} · {list.length}
              </div>
              {list.map((p) => (
                <PostRow
                  key={p.id}
                  post={p}
                  selected={p.id === selectedId}
                  onClick={() => selectPost(p.id)}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="nl-detail so-detail">
        {selected ? (
          <PostDetail
            post={selected}
            invalidate={() =>
              queryClient.invalidateQueries({ queryKey: queryKeys.socialQueue.all })
            }
          />
        ) : (
          <div className="nl-detail-empty">Select a post to review.</div>
        )}
      </div>
    </div>
  );
}

function PostRow({
  post,
  selected,
  onClick,
}: {
  post: SocialQueueItem;
  selected: boolean;
  onClick: () => void;
}) {
  const key = platformKey(post.platform);
  const pillCls = PLATFORM_PILL[key] ?? 'plat';
  const limit = PLATFORM_LIMIT[key] ?? 3000;
  const overCap = post.content.length > limit;

  return (
    <div
      className={`so-row${selected ? ' is-on' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
    >
      <div className="so-row-head">
        <span className={`plat ${pillCls}`}>
          {PLATFORM_LABEL[key] ?? post.platform}
        </span>
        {overCap && (
          <span className="ob-chip ob-chip-warn">
            {post.content.length}/{limit}
          </span>
        )}
        <span className="so-row-time">{relativeTime(post.created_at)}</span>
      </div>
      <div className="so-row-text">{post.content}</div>
      <div className="so-row-foot">
        {post.source && <span className="ob-chip">{post.source}</span>}
        {post.slug && <span className="ob-chip">{post.slug}</span>}
      </div>
    </div>
  );
}

function PostDetail({
  post,
  invalidate,
}: {
  post: SocialQueueItem;
  invalidate: () => void;
}) {
  const [content, setContent] = useState(post.content);
  const [scheduled, setScheduled] = useState(post.scheduled_for ?? '');
  const [savedToast, setSavedToast] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');

  useEffect(() => {
    setContent(post.content);
    setScheduled(post.scheduled_for ?? '');
    setRejecting(false);
    setRejectionReason('');
  }, [post.id]);

  const key = platformKey(post.platform);
  const limit = PLATFORM_LIMIT[key] ?? 3000;
  const overCap = content.length > limit;
  const pct = Math.min(100, (content.length / limit) * 100);
  const barCls = overCap ? 'is-bad' : pct > 90 ? 'is-warn' : '';
  const pillCls = PLATFORM_PILL[key] ?? 'plat';
  const platformLabel = PLATFORM_LABEL[key] ?? post.platform;

  const edited = content !== post.content || scheduled !== (post.scheduled_for ?? '');

  const saveMutation = useMutation({
    mutationFn: async () => {
      const updates: Record<string, unknown> = { content };
      if (scheduled !== (post.scheduled_for ?? '')) {
        updates.scheduled_for = scheduled || null;
      }
      const { error } = await supabase
        .from('social_queue')
        .update(updates)
        .eq('id', post.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 1500);
      invalidate();
    },
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('social_queue')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          content,
          scheduled_for: scheduled || null,
        })
        .eq('id', post.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const rejectMutation = useMutation({
    mutationFn: async (reason: string | null) => {
      // social_queue status enum has no 'rejected' (migration 028). Closest
      // legal terminal is 'failed'; we stash the reason in `error` and add
      // a sentinel prefix so an audit can distinguish reject-by-reviewer
      // from publish-failure.
      const note = reason ? `[reviewer-reject] ${reason}` : '[reviewer-reject]';
      const { error } = await supabase
        .from('social_queue')
        .update({ status: 'failed', error: note })
        .eq('id', post.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setRejecting(false);
      setRejectionReason('');
      invalidate();
    },
  });

  const busy =
    saveMutation.isPending || approveMutation.isPending || rejectMutation.isPending;

  return (
    <>
      <div className="so-detail-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
            <span className={`plat ${pillCls}`}>{platformLabel}</span>
            <span className="ob-chip">{post.source}</span>
            {post.slug && <span className="ob-chip">{post.slug}</span>}
            {edited && (
              <span className="ob-chip ob-chip-tint">
                <Pencil aria-hidden /> Edited
              </span>
            )}
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, margin: '0 0 var(--space-2)' }}>
            {post.account} · {platformLabel}
          </h2>
          <div className="so-detail-meta" style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)' }}>
            <span><b>Source</b> {post.source}</span>
            <span><b>Created</b> {new Date(post.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            <span><b>Schedule</b> {scheduled ? new Date(scheduled).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : 'unscheduled'}</span>
          </div>
        </div>
      </div>

      <div className="so-editor">
        <div>
          <div className="so-editor-pane-label">
            <span>Editor · {platformLabel} body</span>
          </div>
          <textarea
            className="so-text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={post.status !== 'draft'}
          />
          <div className="char-row">
            <span>
              {platformLabel} {content.length} / {limit}
              {overCap && (
                <span style={{ color: 'var(--danger)', marginLeft: 4 }}>
                  +{content.length - limit}
                </span>
              )}
            </span>
            <div className={`char-bar ${barCls}`}>
              <i style={{ width: `${pct}%` }} />
            </div>
          </div>

          <div style={{ marginTop: 'var(--space-3)' }}>
            <label style={{
              fontFamily: 'var(--font-mono)', fontSize: 10.5,
              letterSpacing: '.06em', color: 'var(--fg-faint)',
              textTransform: 'uppercase', display: 'block',
              marginBottom: 4,
            }}>
              Schedule
            </label>
            <input
              type="datetime-local"
              value={scheduled ? new Date(scheduled).toISOString().slice(0, 16) : ''}
              onChange={(e) => setScheduled(e.target.value ? new Date(e.target.value).toISOString() : '')}
              disabled={post.status !== 'draft'}
              style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border-soft)',
                borderRadius: 'var(--radius-sm)',
                padding: '4px var(--space-2)',
                color: 'var(--fg)',
                fontFamily: 'var(--font-mono)', fontSize: 11.5,
                outline: 'none',
              }}
            />
          </div>

          {post.media_path && (
            <div style={{
              marginTop: 'var(--space-3)',
              padding: 'var(--space-3)',
              background: 'var(--bg-base)',
              border: '1px solid var(--border-soft)',
              borderRadius: 'var(--radius-sm)',
            }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 9.5,
                letterSpacing: '.08em', textTransform: 'uppercase',
                color: 'var(--fg-faint)', marginBottom: 'var(--space-2)',
              }}>
                Attached image
              </div>
              {post.media_path.startsWith('http') ? (
                <img
                  src={post.media_path}
                  alt="Post attachment"
                  style={{
                    maxHeight: 280, width: '100%', objectFit: 'contain',
                    borderRadius: 'var(--radius-sm)', background: 'var(--bg-sunken)',
                  }}
                />
              ) : (
                <p style={{
                  fontSize: 'var(--text-caption)', color: 'var(--fg-muted)',
                  wordBreak: 'break-all', margin: 0,
                }}>
                  {post.media_path}{' '}
                  <span style={{ color: 'var(--achievement)' }}>(local — upload pending)</span>
                </p>
              )}
            </div>
          )}
        </div>

        <div>
          <div className="so-editor-pane-label">
            <span>Live preview</span>
          </div>
          <div className="pv-card">
            <div className="pv-head">
              <div className="pv-avatar" />
              <div className="pv-handle">
                <b>{PLATFORM_HANDLE[key] ?? 'Royalti.io'}</b>
                <span>· {platformLabel}{scheduled ? ` · ${new Date(scheduled).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}</span>
              </div>
              <span className={`plat ${pillCls}`} style={{ marginLeft: 'auto' }}>
                {platformLabel}
              </span>
            </div>
            {overCap ? (
              <div className="pv-body" style={{ color: 'var(--danger)' }}>
                ⚠ Over {limit}-char cap by {content.length - limit} chars. Trim or split before approving.
              </div>
            ) : (
              <div className="pv-body">{content}</div>
            )}
            <div className="pv-stats">
              <span>♡ 0</span>
              <span>↻ 0</span>
            </div>
          </div>
        </div>
      </div>

      {rejecting && (
        <div className="nl-reject">
          <label htmlFor="social-reject-reason">Why are you rejecting this post?</label>
          <div className="canned">
            {REJECT_REASONS.map((r) => (
              <button type="button" key={r} onClick={() => setRejectionReason(r)}>
                {r}
              </button>
            ))}
          </div>
          <div className="rrow">
            <input
              id="social-reject-reason"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Add detail (feeds cmo-agent training set)"
              autoFocus
            />
            <button className="ob-btn" onClick={() => setRejecting(false)}>
              Cancel
            </button>
            <button
              className="ob-btn ob-btn-danger-solid"
              onClick={() => rejectMutation.mutate(rejectionReason || null)}
              disabled={busy}
            >
              Confirm reject
            </button>
          </div>
        </div>
      )}

      <div className="nl-actions">
        {overCap && (
          <span className="ob-chip ob-chip-warn">
            blocked · over cap
          </span>
        )}
        {savedToast && <span className="ob-chip ob-chip-ok">Saved</span>}
        <span className="spacer" />
        <HandoffButtons
          draftId={post.id}
          draftTitle={`${platformLabel} · ${content.slice(0, 40)}…`}
          draftBody={content}
          agentSlug={post.source ?? undefined}
        />
        {post.status === 'draft' && (
          <>
            <button
              type="button"
              className="ob-btn ob-btn-danger"
              onClick={() => setRejecting((r) => !r)}
              disabled={busy}
            >
              <XCircle aria-hidden /> Reject…
            </button>
            {edited && (
              <>
                <button
                  type="button"
                  className="ob-btn"
                  onClick={() => {
                    setContent(post.content);
                    setScheduled(post.scheduled_for ?? '');
                  }}
                  title="Reset to original"
                >
                  <RotateCcw aria-hidden />
                </button>
                <button
                  type="button"
                  className="ob-btn"
                  onClick={() => saveMutation.mutate()}
                  disabled={busy}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : (
                    <Save aria-hidden />
                  )}
                  Save
                </button>
              </>
            )}
            <button
              type="button"
              className="ob-btn ob-btn-primary"
              onClick={() => approveMutation.mutate()}
              disabled={busy || overCap}
              title={overCap ? `Body exceeds ${limit}-char cap` : 'Approve & schedule'}
            >
              {approveMutation.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
              Approve & schedule
            </button>
          </>
        )}
      </div>
    </>
  );
}

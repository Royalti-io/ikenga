import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/outbox/social/sent/')({
  component: () => (
    <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--fg-muted)' }}>
      <h3 style={{ margin: 0, marginBottom: 'var(--space-2)', color: 'var(--fg)' }}>Sent posts</h3>
      <p style={{ maxWidth: '52ch', margin: '0 auto var(--space-3)', lineHeight: 1.6 }}>
        Per-channel sent history with engagement metrics. Currently lives in the unified Sent view
        — moves here when there's a need to slice social-only.
      </p>
      <Link
        to="/outbox/sent"
        search={{ type: 'social' as const }}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--tint-fg-active, var(--primary))',
          textDecoration: 'underline',
        }}
      >
        Open unified Sent · filter=social →
      </Link>
    </div>
  ),
});

import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/outbox/sequences/sent/')({
  component: () => (
    <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--fg-muted)' }}>
      <h3 style={{ margin: 0, marginBottom: 'var(--space-2)', color: 'var(--fg)' }}>
        Completed sequences
      </h3>
      <p style={{ maxWidth: '60ch', margin: '0 auto var(--space-3)', lineHeight: 1.6, fontSize: 'var(--text-body-sm)' }}>
        Cohort funnel · sent / opened / replied / bounced per step.
        {' '}
        <strong style={{ color: 'var(--fg)' }}>Deferred</strong>: needs the same
        per-recipient tracking the Active tab is waiting on. Until then, sent
        sequence steps roll up in the unified Sent view.
      </p>
      <Link
        to="/outbox/sent"
        search={{ type: 'email' as const }}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--tint-fg-active, var(--primary))',
          textDecoration: 'underline',
        }}
      >
        Open unified Sent · filter=email →
      </Link>
    </div>
  ),
});

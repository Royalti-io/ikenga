import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/outbox/sequences/active/')({
  component: () => (
    <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--fg-muted)' }}>
      <h3 style={{ margin: 0, marginBottom: 'var(--space-2)', color: 'var(--fg)' }}>
        Active sequences
      </h3>
      <p style={{ maxWidth: '60ch', margin: '0 auto', lineHeight: 1.6, fontSize: 'var(--text-body-sm)' }}>
        Per-recipient cohort grid + per-step open/click/bounce.
        {' '}
        <strong style={{ color: 'var(--fg)' }}>Deferred</strong>: requires an
        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '1px 4px', background: 'var(--bg-sunken)', borderRadius: 3 }}> email_sequence_recipients </code>
        table that doesn&apos;t exist yet. The closest existing data is
        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '1px 4px', background: 'var(--bg-sunken)', borderRadius: 3 }}> outbound_sequences </code>
        (deal-scoped, no per-step opens). Active runs surface in the queue today.
      </p>
    </div>
  ),
});

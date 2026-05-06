import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/outbox/email/schedule/')({
  component: () => (
    <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--fg-muted)' }}>
      <h3 style={{ margin: 0, marginBottom: 'var(--space-2)', color: 'var(--fg)' }}>
        Email schedule
      </h3>
      <p style={{ maxWidth: '52ch', margin: '0 auto', lineHeight: 1.6 }}>
        Calendar of approved + scheduled email sends. Lands when the queue grows past what fits in
        a single page — for now, scheduled emails appear in the queue with their send time.
      </p>
    </div>
  ),
});

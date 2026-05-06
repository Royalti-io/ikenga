import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/outbox/social/schedule/')({
  component: () => (
    <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--fg-muted)' }}>
      <h3 style={{ margin: 0, marginBottom: 'var(--space-2)', color: 'var(--fg)' }}>
        Social schedule
      </h3>
      <p style={{ maxWidth: '52ch', margin: '0 auto', lineHeight: 1.6 }}>
        Calendar of approved + scheduled posts across LinkedIn, X, Bluesky, etc. Lands when posting
        cadence justifies it — for now, scheduled posts appear in the queue with their send time.
      </p>
    </div>
  ),
});

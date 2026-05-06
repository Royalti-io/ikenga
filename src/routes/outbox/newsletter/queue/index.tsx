import { createFileRoute } from '@tanstack/react-router';
import { NewsletterQueuePage } from '@/shell/newsletters/queue-page';

interface QueueSearch {
  focus?: 'cooling';
  draft?: string;
}

export const Route = createFileRoute('/outbox/newsletter/queue/')({
  validateSearch: (search: Record<string, unknown>): QueueSearch => ({
    focus: search.focus === 'cooling' ? 'cooling' : undefined,
    draft: typeof search.draft === 'string' ? search.draft : undefined,
  }),
  component: () => {
    const search = Route.useSearch();
    return <NewsletterQueuePage focus={search.focus} draftId={search.draft} />;
  },
});

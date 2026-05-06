import { createFileRoute } from '@tanstack/react-router';
import { SocialQueuePage } from '@/shell/social/queue-page';

interface SearchParams {
  post?: string;
}

export const Route = createFileRoute('/outbox/social/queue/')({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    post: typeof search.post === 'string' ? search.post : undefined,
  }),
});

function RouteComponent() {
  const { post } = Route.useSearch();
  return <SocialQueuePage postId={post} />;
}

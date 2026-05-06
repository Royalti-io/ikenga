import { createFileRoute } from '@tanstack/react-router';
import { SequencesQueuePage } from '@/shell/sequences/queue-page';

export const Route = createFileRoute('/outbox/sequences/queue/')({
  component: SequencesQueuePage,
});

import { createFileRoute } from '@tanstack/react-router';
import { EmailQueuePage } from '@/shell/email/queue-page';

export const Route = createFileRoute('/outbox/email/queue/')({
  component: EmailQueuePage,
});

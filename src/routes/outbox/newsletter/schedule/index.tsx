import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ScheduleCalendar } from '@/shell/newsletters/schedule-calendar';

export const Route = createFileRoute('/outbox/newsletter/schedule/')({
  component: NewsletterSchedulePage,
});

function NewsletterSchedulePage() {
  const navigate = useNavigate();
  return (
    <ScheduleCalendar
      onPillClick={(p) => {
        if (p.draftId) {
          navigate({
            to: '/outbox/newsletter/queue',
            search: { draft: p.draftId },
          });
        }
      }}
    />
  );
}

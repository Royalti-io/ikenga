import { createFileRoute } from '@tanstack/react-router';
import { MessageSquare } from 'lucide-react';
import { OutboundDeepLink } from '@/shell/outbox-deeplink';

export const Route = createFileRoute('/outbox/social')({
	component: () => (
		<OutboundDeepLink
			view="social"
			title="Outbox · Social"
			description="Scheduled social posts from the Outbound app."
			Icon={MessageSquare}
		/>
	),
});

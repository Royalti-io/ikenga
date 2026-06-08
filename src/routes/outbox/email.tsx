import { createFileRoute } from '@tanstack/react-router';
import { Mail } from 'lucide-react';
import { OutboundDeepLink } from '@/shell/outbox-deeplink';

export const Route = createFileRoute('/outbox/email')({
	component: () => (
		<OutboundDeepLink
			view="email"
			title="Outbox · Email"
			description="Outgoing email queue from the Outbound app."
			Icon={Mail}
		/>
	),
});

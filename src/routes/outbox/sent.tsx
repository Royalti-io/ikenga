import { createFileRoute } from '@tanstack/react-router';
import { Send } from 'lucide-react';
import { OutboundDeepLink } from '@/shell/outbox-deeplink';

export const Route = createFileRoute('/outbox/sent')({
	component: () => (
		<OutboundDeepLink
			view="sent"
			title="Outbox · Sent"
			description="History of sent outbound messages."
			Icon={Send}
		/>
	),
});

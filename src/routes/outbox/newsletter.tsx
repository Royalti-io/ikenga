import { createFileRoute } from '@tanstack/react-router';
import { Newspaper } from 'lucide-react';
import { OutboundDeepLink } from '@/shell/outbox-deeplink';

export const Route = createFileRoute('/outbox/newsletter')({
	component: () => (
		<OutboundDeepLink
			view="newsletter"
			title="Outbox · Newsletter"
			description="Newsletter broadcasts from the Outbound app."
			Icon={Newspaper}
		/>
	),
});

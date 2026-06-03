import type { LucideIcon } from 'lucide-react';
import { Wrench } from 'lucide-react';

import { FeedbackState } from '@/components/ui/feedback-state';

interface StubPanelProps {
	title: string;
	description?: string;
	icon?: LucideIcon;
	reason?: string;
}

/**
 * Placeholder UI for routes ported from ikenga whose feature
 * implementation depends on components/APIs that are not yet wired
 * into the desktop app. The route exists so navigation works; the
 * page itself is a friendly "Not yet wired up" panel.
 */
export function StubPanel({ title, description, icon: Icon = Wrench, reason }: StubPanelProps) {
	return (
		<div className="flex h-full flex-col">
			<header className="border-b border-border px-6 py-4">
				<div className="flex items-center gap-2">
					<Icon className="h-5 w-5 text-muted-foreground" />
					<h1 className="text-lg font-semibold">{title}</h1>
				</div>
				{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
			</header>
			<FeedbackState
				variant="empty"
				dashed
				fill
				className="flex-1"
				icon={Icon}
				heading="Not yet wired up"
				body={
					reason ??
					'This page was ported as a route stub. The feature components will be added in a follow-up phase.'
				}
			/>
		</div>
	);
}

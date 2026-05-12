import type { LucideIcon } from 'lucide-react';
import { Wrench } from 'lucide-react';

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
			<div className="flex flex-1 items-center justify-center p-6">
				<div className="max-w-md rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
					<Icon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
					<p className="text-sm font-medium">Not yet wired up</p>
					<p className="mt-1 text-xs text-muted-foreground">
						{reason ??
							'This page was ported as a route stub. The feature components will be added in a follow-up phase.'}
					</p>
				</div>
			</div>
		</div>
	);
}

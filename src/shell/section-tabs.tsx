import { Link, useRouterState } from '@tanstack/react-router';
import { cn } from '@/components/ui/utils';

export interface SectionTabItem {
	to: string;
	label: string;
	/** When true, only consider this tab active on exact path match (prevents the index tab from staying active on every sub-route). */
	exact?: boolean;
}

export function SectionTabs({ items }: { items: SectionTabItem[] }) {
	const { location } = useRouterState();
	const path = location.pathname;
	return (
		<div className="border-b border-border bg-background">
			<nav className="flex gap-1 overflow-x-auto px-3 py-1">
				{items.map((item) => {
					const isActive = item.exact ? path === item.to : path.startsWith(item.to);
					return (
						<Link
							key={item.to}
							to={item.to}
							className={cn(
								'rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors',
								'text-muted-foreground hover:text-foreground hover:bg-accent',
								isActive && 'bg-accent text-foreground'
							)}
						>
							{item.label}
						</Link>
					);
				})}
			</nav>
		</div>
	);
}

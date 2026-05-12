import type { ReactNode } from 'react';

import { cn } from '@/components/ui/utils';

interface SettingGroupProps {
	title: string;
	children: ReactNode;
	className?: string;
}

export function SettingGroup({ title, children, className }: SettingGroupProps) {
	return (
		<section
			className={cn(
				'overflow-hidden rounded-lg border border-[var(--border-soft)] bg-card',
				className
			)}
		>
			<header className="border-b border-[var(--border-soft)] bg-[var(--bg-sunken)] px-4 py-2.5">
				<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					{title}
				</h3>
			</header>
			<div className="divide-y divide-border">{children}</div>
		</section>
	);
}

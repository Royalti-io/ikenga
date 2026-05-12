import * as React from 'react';

import { cn } from '@/components/ui/utils';

interface TableSkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
	/** Number of placeholder rows to render. Defaults to 8. */
	rows?: number;
	/** Number of placeholder columns to render. Defaults to 5. */
	cols?: number;
	/** Whether to render a header placeholder row. Defaults to true. */
	showHeader?: boolean;
}

/**
 * Generic shimmering table skeleton placeholder. Wraps the rows in a card-like
 * bordered container so it matches the eventual table layout without shifting.
 * Use while `loading === true` on client pages or as the fallback in a
 * Suspense / `loading.tsx` sibling for server pages.
 */
export function TableSkeleton({
	rows = 8,
	cols = 5,
	showHeader = true,
	className,
	...props
}: TableSkeletonProps) {
	const rowIndexes = Array.from({ length: rows });
	const colIndexes = Array.from({ length: cols });

	return (
		<div
			data-slot="table-skeleton"
			role="status"
			aria-label="Loading table data"
			aria-busy="true"
			className={cn('overflow-hidden rounded-lg border border-gray-200 bg-white', className)}
			{...props}
		>
			{showHeader && (
				<div
					className="grid gap-4 border-b border-gray-200 bg-gray-50 px-4 py-3"
					style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
				>
					{colIndexes.map((_, i) => (
						<div key={`th-${i}`} className="h-3.5 animate-pulse rounded bg-gray-200" />
					))}
				</div>
			)}
			<div className="divide-y divide-gray-100">
				{rowIndexes.map((_, r) => (
					<div
						key={`tr-${r}`}
						className="grid gap-4 px-4 py-4"
						style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
					>
						{colIndexes.map((_, c) => (
							<div
								key={`td-${r}-${c}`}
								className={cn(
									'h-4 animate-pulse rounded bg-gray-100',
									// Vary widths slightly per column for a less mechanical look
									c === 0 && 'w-3/4',
									c === cols - 1 && 'w-1/2'
								)}
							/>
						))}
					</div>
				))}
			</div>
			<span className="sr-only">Loading…</span>
		</div>
	);
}

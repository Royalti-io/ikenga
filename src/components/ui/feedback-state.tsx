import * as React from 'react';
import { AlertCircle, CircleOff, Loader2, type LucideIcon } from 'lucide-react';

import { cn } from '@/components/ui/utils';

// Consolidated empty / loading / error / stale feedback surface — the single
// component the pane/view/dock "no content" states render through. Replaces 8
// hand-rolled implementations (StubPanel, ChatView empty/loading/error,
// TerminalView placeholder, ToolOutputView stale, DockEmpty, SessionsPage
// loading/empty/error). Token-only tones; tone is conveyed by icon + text, not
// colour alone (WCAG 1.4.1).
//
// Spec: plans/shell-design-system/parts/components/feedback-state.md
//       + designs/feedback-state.html (the locked Dusk Wood mockup).

export type FeedbackVariant = 'empty' | 'loading' | 'error' | 'streaming' | 'stale';

export interface FeedbackStateProps {
	variant?: FeedbackVariant;
	/** Fill the parent (h-full) instead of the default min-h-[60vh]. */
	fill?: boolean;
	/** Wrap the content in a dashed-border card (stub / placeholder contexts). */
	dashed?: boolean;
	/** Override the default icon for the variant. */
	icon?: LucideIcon;
	heading?: string;
	body?: React.ReactNode;
	/** CTA(s) rendered below the body (e.g. a retry button). */
	action?: React.ReactNode;
	className?: string;
}

const DEFAULT_ICON: Partial<Record<FeedbackVariant, LucideIcon>> = {
	empty: CircleOff,
	error: AlertCircle,
};

export function FeedbackState({
	variant = 'empty',
	fill = false,
	dashed = false,
	icon,
	heading,
	body,
	action,
	className,
}: FeedbackStateProps) {
	// Stale: a compact, non-centered mono caption (the tool-output stale slot).
	if (variant === 'stale') {
		return (
			<div
				className={cn(
					'flex w-full items-center justify-center p-6 text-center font-mono text-[11px] uppercase tracking-wider',
					fill && 'h-full',
					className
				)}
				style={{ color: 'var(--fg-faint)' }}
			>
				{body ?? heading}
			</div>
		);
	}

	const isError = variant === 'error';
	const isLive = variant === 'loading' || variant === 'streaming';
	const Icon = icon ?? DEFAULT_ICON[variant];

	const lead =
		variant === 'loading' ? (
			<Loader2
				aria-hidden
				className="size-5 animate-spin motion-reduce:animate-none"
				style={{ color: 'var(--fg-muted)' }}
			/>
		) : variant === 'streaming' ? (
			<div
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				className="h-1.5 overflow-hidden rounded-full"
				style={{ width: 'min(420px, 60%)', background: 'var(--bg-sunken)' }}
			>
				<span
					className="block h-full w-2/5 rounded-full animate-pulse motion-reduce:animate-none"
					style={{
						background: 'linear-gradient(90deg, transparent, var(--achievement), transparent)',
					}}
				/>
			</div>
		) : Icon ? (
			<Icon
				aria-hidden
				className="size-7"
				style={{ color: isError ? 'var(--danger)' : 'var(--fg-faint)' }}
			/>
		) : null;

	const content = (
		<>
			{lead}
			{heading && (
				<div
					className="font-medium"
					style={{
						fontFamily: 'var(--font-display)',
						fontSize: 'var(--text-h3)',
						color: isError ? 'var(--fg)' : 'var(--fg-muted)',
					}}
				>
					{heading}
				</div>
			)}
			{body && (
				<div
					className="max-w-xs"
					style={{ fontSize: 'var(--text-body-sm)', color: 'var(--fg-muted)' }}
				>
					{body}
				</div>
			)}
			{action && (
				<div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>
			)}
		</>
	);

	const inner = dashed ? (
		<div
			className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6"
			style={{ borderColor: 'var(--border)' }}
		>
			{content}
		</div>
	) : isError ? (
		<div
			className="flex max-w-sm flex-col items-center gap-2 rounded-md border p-4"
			style={{
				borderColor: 'color-mix(in srgb, var(--danger) 50%, transparent)',
				background: 'var(--danger-soft)',
			}}
		>
			{content}
		</div>
	) : (
		content
	);

	return (
		<div
			role={isError ? 'alert' : isLive ? 'status' : undefined}
			aria-live={isError ? 'assertive' : isLive ? 'polite' : undefined}
			className={cn(
				'flex w-full flex-col items-center justify-center gap-3 p-6 text-center',
				fill ? 'h-full' : 'min-h-[60vh]',
				className
			)}
		>
			{inner}
		</div>
	);
}

// Phase-1 placeholder detached surface (plans/multi-window WP-05).
//
// Proves the thin mount path end-to-end: it renders this window's identity
// (resolved from the spawn URL params) and the live `window://` lifecycle
// state subscribed at the root — so spawning/closing a sibling window from
// the primary visibly updates here, demonstrating the cross-window event bus
// with no second TanStack Query cache. WP-06 replaces this with the real
// chat + viewer surfaces against the same `DetachedSurfaceProps` contract.

import type { DetachedSurfaceProps } from '../registry';

export default function PlaceholderSurface({ ctx, lifecycle }: DetachedSurfaceProps) {
	return (
		<div className="flex h-full w-full flex-col gap-4 overflow-auto p-6 text-sm">
			<header className="flex flex-col gap-1">
				<h1 className="font-medium text-base text-foreground">Detached window</h1>
				<p className="text-muted-foreground">
					Thin single-surface entry — no activity bar, sidebar, or pane chrome. WP-06 mounts the
					real chat / viewer surface here.
				</p>
			</header>

			<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-muted-foreground">
				<dt className="text-foreground">label</dt>
				<dd className="font-mono">{ctx.label}</dd>
				<dt className="text-foreground">kind</dt>
				<dd className="font-mono">{ctx.kind}</dd>
				<dt className="text-foreground">surface_set</dt>
				<dd className="font-mono">{ctx.surfaces.length > 0 ? ctx.surfaces.join(', ') : '—'}</dd>
				<dt className="text-foreground">project</dt>
				<dd className="font-mono">{ctx.projectId ?? '(follows primary)'}</dd>
			</dl>

			<section className="flex flex-col gap-1 border-border border-t pt-4">
				<h2 className="font-medium text-foreground">window:// event bus</h2>
				<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-muted-foreground">
					<dt className="text-foreground">last topic</dt>
					<dd className="font-mono">{lifecycle.lastTopic ?? '(none yet)'}</dd>
					<dt className="text-foreground">opened / closed</dt>
					<dd className="font-mono">
						{lifecycle.openedCount} / {lifecycle.closedCount}
					</dd>
				</dl>
				{lifecycle.lastEnvelope && (
					<pre className="mt-1 overflow-auto rounded-md bg-muted p-2 font-mono text-muted-foreground text-xs">
						{JSON.stringify(lifecycle.lastEnvelope.payload, null, 2)}
					</pre>
				)}
			</section>
		</div>
	);
}

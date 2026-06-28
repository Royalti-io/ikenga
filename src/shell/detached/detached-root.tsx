// Thin detached root (plans/multi-window WP-05).
//
// The detached counterpart to `shell/workspace.tsx`: it mounts ONLY the
// surface(s) named in this window's `surface_set`, with none of the
// activity-bar / sidebar / pane-group chrome (pulling that in would defeat
// the perf goal — G-02). The `window://` lifecycle bus is subscribed once
// here at the substrate level and threaded into every surface, so surfaces
// stay in sync over the shared Rust core rather than mirroring its state.

import { Suspense } from 'react';

import type { WindowContext } from '@/lib/window/window-context';
import { registeredSurfaceIds, resolveSurface } from './registry';
import { useWindowLifecycle } from './use-window-lifecycle';

function SurfaceFallback() {
	return (
		<div
			role="status"
			aria-live="polite"
			className="flex h-full w-full items-center justify-center text-muted-foreground text-sm"
		>
			Loading surface…
		</div>
	);
}

function UnknownSurface({ id }: { id: string }) {
	return (
		<div className="flex h-full w-full flex-col items-center justify-center gap-1 p-6 text-center text-sm">
			<p className="text-foreground">Unknown surface “{id}”.</p>
			<p className="text-muted-foreground">
				Registered: {registeredSurfaceIds().join(', ') || '—'}
			</p>
		</div>
	);
}

export function DetachedRoot({ ctx }: { ctx: WindowContext }) {
	// One subscription for the whole window — the cross-window event seam.
	const lifecycle = useWindowLifecycle();

	// Flavor C is single-surface; render exactly the declared `surface_set`.
	// Fall back to the placeholder when empty so the thin path is always
	// reachable/observable (and so a bare `?window=detached-1` still boots).
	const surfaceIds = ctx.surfaces.length > 0 ? ctx.surfaces : ['placeholder'];

	return (
		<div
			data-detached-window={ctx.label}
			className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground"
		>
			{surfaceIds.map((id) => {
				const surface = resolveSurface(id);
				if (!surface) {
					return <UnknownSurface key={id} id={id} />;
				}
				const Body = surface.component;
				return (
					<Suspense key={id} fallback={<SurfaceFallback />}>
						<Body ctx={ctx} lifecycle={lifecycle} />
					</Suspense>
				);
			})}
		</div>
	);
}

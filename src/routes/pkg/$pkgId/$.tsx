// Catch-all for installed-package iframe routes.
//
// Resolves /pkg/<pkgId>/<splat> against UiRoutesRegistry. If the registry
// has an entry for `pkg://<pkgId>/<splat>` with kind=iframe, we mount it via
// PkgIframeHost. Anything else (no entry, kind=component for a non-builtin,
// pkg uninstalled mid-session) renders a NotFound state — making uninstall
// a real 404, which is the contract this whole mechanism exists to provide.
//
// Builtins (Tasks) keep their host route file (`src/routes/tasks/...`); the
// catch-all is the third-party path. The two coexist because the host route
// file wins under TanStack's router resolution.

import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { PkgIframeHost } from '@/components/pkg/pkg-iframe-host';
import { PkgWebviewHost } from '@/components/pkg/pkg-webview-host';
import { pkgKernelStatus } from '@/lib/tauri-cmd';

export const Route = createFileRoute('/pkg/$pkgId/$')({
	component: PkgRouteCatchAll,
});

interface UiRouteEntry {
	pkg_id: string;
	virtual_path: string;
	path: string;
	kind: string;
	source: string;
}

type State =
	| { kind: 'loading' }
	| { kind: 'iframe'; entry: UiRouteEntry }
	| { kind: 'webview'; entry: UiRouteEntry }
	| { kind: 'unmountable'; entry: UiRouteEntry }
	| { kind: 'not_found'; routePath: string };

function PkgRouteCatchAll() {
	const { pkgId, _splat } = Route.useParams() as { pkgId: string; _splat: string };
	// The splat doesn't include the leading slash; the registry stores
	// entries with a leading-slash path, so we add it back here.
	const routePath = `/${_splat ?? ''}`.replace(/\/+$/, '/').replace(/\/$/, '') || '/';

	const [state, setState] = useState<State>({ kind: 'loading' });

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const status = await pkgKernelStatus();
				const reg = (status.registries.ui_routes ?? {}) as { entries?: UiRouteEntry[] };
				const entries = reg.entries ?? [];
				// Match on (pkg_id, path). Trailing-slash variants both supported
				// because manifests commonly declare `/foo` and `/foo/` as separate
				// routes pointing at different sources.
				const entry =
					entries.find((e) => e.pkg_id === pkgId && e.path === routePath) ??
					entries.find((e) => e.pkg_id === pkgId && e.path === routePath + '/');
				if (cancelled) return;
				if (!entry) {
					setState({ kind: 'not_found', routePath });
					return;
				}
				if (entry.kind === 'iframe') {
					setState({ kind: 'iframe', entry });
				} else if (entry.kind === 'webview') {
					setState({ kind: 'webview', entry });
				} else {
					setState({ kind: 'unmountable', entry });
				}
			} catch (e) {
				if (!cancelled) {
					setState({
						kind: 'not_found',
						routePath: `${routePath} (resolve failed: ${(e as Error).message})`,
					});
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [pkgId, routePath]);

	if (state.kind === 'loading') {
		return <div className="p-6 text-sm opacity-60">Resolving package route…</div>;
	}
	if (state.kind === 'not_found') {
		return (
			<div className="p-6 text-sm">
				<div className="font-semibold mb-1">No such package route</div>
				<div className="opacity-70">
					<code>
						pkg://{pkgId}
						{state.routePath}
					</code>{' '}
					is not registered. The package may have been uninstalled, or this URL is stale.
				</div>
			</div>
		);
	}
	if (state.kind === 'unmountable') {
		return (
			<div className="p-6 text-sm">
				<div className="font-semibold mb-1">Package route is not mountable</div>
				<div className="opacity-70">
					<code>{state.entry.virtual_path}</code> declares
					<code> kind: "{state.entry.kind}"</code>. Only <code>kind: "iframe"</code> and{' '}
					<code>kind: "webview"</code> are supported for installable packages — component-kind
					routes are reserved for host-builtin marker installs.
				</div>
			</div>
		);
	}
	if (state.kind === 'webview') {
		// The kernel keys child-webview handles on (pkg_id, pane_id). We don't
		// have a true Pane abstraction at this catch-all (panes belong to the
		// shell's layout layer; this route renders into whichever pane was
		// focused at navigation time), so we derive a stable pane_id from the
		// pkg + route path. That's "stable across re-renders of the same
		// route" — which is the only stability the kernel needs — without
		// requiring us to plumb the real pane id all the way down here.
		const paneId = `${state.entry.pkg_id}:${state.entry.path}`;
		return (
			<PkgWebviewHost pkgId={state.entry.pkg_id} paneId={paneId} source={state.entry.source} />
		);
	}
	return <PkgIframeHost pkgId={state.entry.pkg_id} source={state.entry.source} />;
}

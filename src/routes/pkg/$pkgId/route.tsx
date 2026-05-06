// Parent route for `/pkg/$pkgId` and its splat child `./$.tsx`.
//
// The parent itself resolves the manifest's `/` route entry and mounts the
// iframe — that handles `/pkg/$pkgId` and `/pkg/$pkgId/`. The `$` splat
// child renders for non-empty sub-paths (e.g. `/pkg/$pkgId/details`); when
// the splat is matched, TanStack hides the parent component and renders the
// child instead. We render `<Outlet />` only as a passthrough — but the
// splat child is itself a leaf, so the Outlet is unused and harmless.

import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { PkgIframeHost } from '@/components/pkg/pkg-iframe-host';
import { pkgKernelStatus } from '@/lib/tauri-cmd';

export const Route = createFileRoute('/pkg/$pkgId')({
  component: PkgRouteParent,
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
  | { kind: 'unmountable'; entry: UiRouteEntry }
  | { kind: 'not_found' };

function PkgRouteParent() {
  const { pkgId } = Route.useParams() as { pkgId: string };
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await pkgKernelStatus();
        const reg = (status.registries.ui_routes ?? {}) as { entries?: UiRouteEntry[] };
        const entries = reg.entries ?? [];
        const entry =
          entries.find((e) => e.pkg_id === pkgId && e.path === '/') ??
          entries.find((e) => e.pkg_id === pkgId && (e.path === '' || e.path === 'index'));
        if (cancelled) return;
        if (!entry) {
          setState({ kind: 'not_found' });
          return;
        }
        setState(
          entry.kind === 'iframe'
            ? { kind: 'iframe', entry }
            : { kind: 'unmountable', entry },
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[pkg-route-parent] resolve failed', e);
        if (!cancelled) setState({ kind: 'not_found' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pkgId]);

  if (state.kind === 'loading') {
    return <div className="p-6 text-sm opacity-60">Resolving package route…</div>;
  }
  if (state.kind === 'not_found') {
    return (
      <div className="p-6 text-sm">
        <div className="font-semibold mb-1">No such package route</div>
        <div className="opacity-70">
          <code>pkg://{pkgId}/</code> is not registered. The package may have
          been uninstalled, or this URL is stale.
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
          <code> kind: "{state.entry.kind}"</code>. Only{' '}
          <code>kind: "iframe"</code> is supported for installable packages.
        </div>
      </div>
    );
  }
  return <PkgIframeHost pkgId={pkgId} source={state.entry.source} />;
}

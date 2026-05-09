// Index handler for the bare `/pkg/$pkgId` URL. Mounts the manifest's
// canonical landing route (path: "/" or first declared route) so users
// don't see "not found" when they navigate to a pkg's root URL via
// settings, the activity bar, or a deep link without a sub-path.
//
// The splat sibling at `./$.tsx` handles all `/pkg/$pkgId/<sub-path>`
// URLs. Both are rendered inside the layout in `./route.tsx`.

import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { PkgIframeHost } from '@/components/pkg/pkg-iframe-host';
import { pkgKernelStatus } from '@/lib/tauri-cmd';

export const Route = createFileRoute('/pkg/$pkgId/')({
  component: PkgRouteIndex,
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

function PkgRouteIndex() {
  const { pkgId } = Route.useParams() as { pkgId: string };
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await pkgKernelStatus();
        const reg = (status.registries.ui_routes ?? {}) as { entries?: UiRouteEntry[] };
        const entries = reg.entries ?? [];
        // Resolution order: manifest's literal "/" route → empty/index
        // alias → first declared route for this pkg. The third fallback
        // matters because most pkgs (finance, gtm, exec, …) declare
        // sub-paths only and would otherwise 404 on bare URL nav.
        const entry =
          entries.find((e) => e.pkg_id === pkgId && e.path === '/') ??
          entries.find((e) => e.pkg_id === pkgId && (e.path === '' || e.path === 'index')) ??
          entries.find((e) => e.pkg_id === pkgId);
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
        console.error('[pkg-route-index] resolve failed', e);
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
          <code>pkg://{pkgId}</code> is not installed, or declares no UI
          routes. Open the package manager to install or inspect.
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

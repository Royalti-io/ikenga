import { mark } from '@/lib/boot-timing';
mark('boot:js-start');

import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import { routeTree } from './routeTree.gen';
import { queryClient } from '@/lib/query-client';
import { installIkengaDomSync, useIkengaStore } from '@/lib/ikenga/theme-store';
import { installNativeMenu } from '@/shell/native-menu';
import { initDefaultCwd } from '@/lib/shell/default-cwd';
import { useShellStore } from '@/lib/shell/shell-store';

import './styles.css';
import '@xterm/xterm/css/xterm.css';

// Dev-only globals (e.g. `window.ikengaAcpSmoke` for the ACP migration
// Phase 3 smoke test). Lazy-imported so production builds tree-shake the
// helper entirely.
if (import.meta.env.DEV) {
  void import('@/lib/dev');
}

// Sync Ikenga data-attrs onto <html> before first React render so the very
// first paint already has the right theme/mode/density/workspace applied.
installIkengaDomSync();

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  context: { queryClient },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Install native menu best-effort (Mac-only; silently no-ops elsewhere).
void installNativeMenu();

// Pull the authoritative FS allowlist from Rust so the Files panel reflects
// what the Rust resolver will actually permit. Fire-and-forget; failures
// (test env, pre-setup boot) leave the persisted snapshot in place.
void useShellStore.getState().hydrateFileRootsFromRust();

// Resolve $HOME once so `defaultCwd()` (used by chat/terminal/session
// fallbacks) can return it synchronously. Fire-and-forget — failure leaves
// the helper falling back to '~'.
void initDefaultCwd();

// Pull the durable settings_kv mirror (migration 0013). Same fire-and-forget
// semantics — failures leave the localStorage-hydrated snapshot in place,
// successes overwrite Zustand state with the Tauri-side authoritative copy.
void useShellStore.getState().hydrateSettingsFromRust();
void useIkengaStore.getState().hydrateAppearanceFromRust();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {import.meta.env.DEV && <ReactQueryDevtools buttonPosition="bottom-right" />}
    </QueryClientProvider>
  </React.StrictMode>
);

import { mark } from '@/lib/boot-timing';
mark('boot:js-start');

import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import { routeTree } from './routeTree.gen';
import { queryClient } from '@/lib/query-client';
import { installIkengaDomSync } from '@/lib/ikenga/theme-store';
import { installNativeMenu } from '@/shell/native-menu';

import './styles.css';
import '@xterm/xterm/css/xterm.css';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {import.meta.env.DEV && <ReactQueryDevtools buttonPosition="bottom-right" />}
    </QueryClientProvider>
  </React.StrictMode>
);

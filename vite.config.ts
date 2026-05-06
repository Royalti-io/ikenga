import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Allowlist, not denylist. Vite's HMR is what makes Tauri dev tolerable
      // (edit a .tsx → component swaps in place, panes/terminal/chat survive),
      // so we don't want to disable the watch — but every non-source folder
      // we watch is a chance for a stray .html / .css change to trigger a
      // full-page reload (Vite hard-codes full-reload on .html in
      // vite/src/node/server/hmr.ts) or a wasted HMR pass.
      //
      // Only three roots feed Vite's module graph:
      //   - index.html  (the entry)
      //   - src/        (the React app)
      //   - public/     (Vite-served static assets)
      // Everything else (design/, sidecars/, hyperframes-projects/,
      // src-tauri/, .tanstack/, dist/, …) is built or served by something
      // other than Vite. Returning `true` from the function ignores a path.
      ignored: (file) => {
        if (file === __dirname) return false; // chokidar starts at the root
        const rel = file.slice(__dirname.length + 1);
        const top = rel.split(/[\/\\]/)[0];
        return !(top === 'src' || top === 'public' || top === 'index.html');
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'esnext',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  optimizeDeps: {
    exclude: ['@tauri-apps/api'],
  },
});

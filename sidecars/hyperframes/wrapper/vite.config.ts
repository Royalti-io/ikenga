import { defineConfig } from 'vite';

// PkgIframeHost serves dist/index.html via srcdoc and injects a <base href>
// pointing at the pkg-content axum endpoint. All subresource paths must be
// relative to that base, so `base: './'` is non-negotiable.
//
// We pin output filenames so the manifest's `ui.routes[].source` and any
// future asset references stay stable across builds — no hashed names.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: '.',
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app-[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});

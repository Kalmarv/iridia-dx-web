import { defineConfig } from 'vite';

// Relative asset paths: the page works from any folder (a GitHub Pages project site, orca share, a file server).
export default defineConfig({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4096 },
  server: { host: '127.0.0.1' },
});

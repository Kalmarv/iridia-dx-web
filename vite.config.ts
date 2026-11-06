import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';

// Relative asset paths: the page works from any folder (a GitHub Pages project site, a file server).
export default defineConfig({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4096 },
  // the Coverage route exists where its table does: scripts/assets.mjs copies coverage.json into public/ first
  define: { __COVERAGE__: JSON.stringify(existsSync('public/coverage.json')) },
  server: { host: '127.0.0.1' },
});

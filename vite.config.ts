import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';

// Relative asset paths: the page works from any folder (a GitHub Pages project site, orca share, a file server).
export default defineConfig({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4096 },
  // the Coverage route exists where its table does: scripts/assets.mjs copies coverage.json into public/ first
  define: { __COVERAGE__: JSON.stringify(existsSync('public/coverage.json')) },
  // docs/logo.svg is the favicon and the header's mark: the dev server may read it from outside web/
  server: { host: '127.0.0.1', fs: { allow: ['.', '../docs/logo.svg'] } },
});

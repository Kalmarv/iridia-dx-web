import { readFileSync } from 'node:fs';
import { iridiaRev, releaseFile } from './scripts/iridia.mjs';
import { defineConfig } from 'vite';

// Relative asset paths: the page works from any folder (a GitHub Pages project site, a file server).
export default defineConfig({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4096 },
  // the iridia commit the glue pins (the coverage table, which scripts/assets.mjs fetches, was made at it), its
  // version and whether that version is on crates.io (scripts/assets.mjs asks)
  define: { __IRIDIA__: readFileSync(releaseFile(iridiaRev()), 'utf8') },
  server: { host: '127.0.0.1' },
});

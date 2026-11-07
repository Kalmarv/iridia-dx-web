import { iridiaRev } from './scripts/iridia.mjs';
import { defineConfig } from 'vite';

// Relative asset paths: the page works from any folder (a GitHub Pages project site, a file server).
export default defineConfig({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4096 },
  // the iridia commit the glue pins, which the coverage table (scripts/assets.mjs fetches it) was made at
  define: { __IRIDIA_REV__: JSON.stringify(iridiaRev()) },
  server: { host: '127.0.0.1' },
});

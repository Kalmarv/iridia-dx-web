// Copies what the page fetches at run time into public/: each example's program and source (not Microsoft's
// reference listings, which are for the glue's tests), and the coverage table where it has been generated.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(web, 'examples');
const to = join(web, 'public', 'examples');
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
const shipped = /\.(hlsl|asm|dxbc|dxil|pso|vso)$/;
for (const folder of readdirSync(from)) {
  const source = join(from, folder);
  if (!statSync(source).isDirectory()) continue;
  for (const file of readdirSync(source)) {
    if (!shipped.test(file)) continue;
    mkdirSync(join(to, folder), { recursive: true });
    cpSync(join(source, file), join(to, folder, file));
  }
}
const coverage = join(web, 'coverage', 'coverage.json');
const coverageOut = join(web, 'public', 'coverage.json');
rmSync(coverageOut, { force: true });
if (existsSync(coverage)) cpSync(coverage, coverageOut);

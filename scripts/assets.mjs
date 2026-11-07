// Copies what the page fetches at run time into public/: each example's program and source (not Microsoft's
// reference listings, which are for the glue's tests), and iridia's coverage table at the commit the glue pins
// (fetched once into coverage/, which git ignores; a build without it fails rather than ship a page without it).
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { iridiaRev, web } from './iridia.mjs';

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
const rev = iridiaRev();
const coverage = join(web, 'coverage', `${rev}.json`);
if (!existsSync(coverage)) {
  const url = `https://raw.githubusercontent.com/Kalmarv/iridia/${rev}/docs/coverage/coverage.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`iridia's coverage table at ${rev.slice(0, 7)}: ${r.status} ${r.statusText} from ${url}`);
  const text = await r.text();
  if (JSON.parse(text).version !== 1) throw new Error(`iridia's coverage table at ${rev.slice(0, 7)} is not schema version 1`);
  mkdirSync(join(web, 'coverage'), { recursive: true });
  writeFileSync(`${coverage}.part`, text);
  renameSync(`${coverage}.part`, coverage);
}
cpSync(coverage, join(web, 'public', 'coverage.json'));

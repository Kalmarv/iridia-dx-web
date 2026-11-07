// The iridia commit the glue is pinned at: every iridia crate in glue/Cargo.toml names the same git rev, and the
// page's coverage table is iridia's own at that commit.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const web = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The full sha every iridia dependency of the glue is pinned to; throws when they differ or none is pinned. */
export function iridiaRev() {
  const manifest = readFileSync(join(web, 'glue', 'Cargo.toml'), 'utf8');
  const revs = new Set(
    [...manifest.matchAll(/git = "https:\/\/github\.com\/Kalmarv\/iridia", rev = "([0-9a-f]{40})"/g)].map((m) => m[1]),
  );
  if (revs.size !== 1) throw new Error(`glue/Cargo.toml pins iridia at ${revs.size ? [...revs].join(', ') : 'no full rev'}; expected one`);
  return [...revs][0];
}

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

/** The version of iridia that glue/Cargo.lock builds at the pinned rev. */
export function iridiaVersion() {
  const lock = readFileSync(join(web, 'glue', 'Cargo.lock'), 'utf8');
  const m = lock.match(/name = "iridia"\nversion = "([^"]+)"/);
  if (!m) throw new Error('glue/Cargo.lock has no iridia package');
  return m[1];
}

/** Where scripts/assets.mjs writes whether that version is on crates.io, for vite.config.ts to build in. */
export const releaseFile = (rev) => join(web, 'coverage', `${rev}.release.json`);

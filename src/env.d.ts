/**
 * The iridia the glue builds: the full sha of the pinned commit (the coverage table, public/coverage.json, is
 * iridia's at it), its version, and whether that version is on crates.io.
 */
declare const __IRIDIA__: { rev: string; version: string; released: boolean };

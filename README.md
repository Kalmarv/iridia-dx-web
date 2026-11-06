# iridia + dx web demo

A static page that runs iridia and dx in the browser as WebAssembly: drop a compiled shader (DXBC, DXIL or Direct3D 9)
or open an example, and see its bytes, Microsoft-exact disassembly, reflection, the IR and WGSL iridia writes, a live
WebGPU preview, and a run of one pixel on the CPU beside the GPU's. No server: everything happens in the page.

## Building

Needs Rust 1.99 with the `wasm32-unknown-unknown` target, wasm-pack 0.13 and pnpm 10.

```sh
cd web
pnpm install
pnpm wasm      # the glue as wasm, into pkg/
pnpm dev       # a dev server on 127.0.0.1
pnpm build     # the page, into dist/ (relative paths: serve it from any folder)
```

The glue's own checks, as CI runs them:

```sh
cd web/glue
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

The page's browser checks run in a Chrome with WebGPU, started with `--remote-debugging-port` (they wait on the
workspace's `data-preview` state: starting, building, ready, failed or none):

```sh
node scripts/variants.mjs http://127.0.0.1:5173/ --cdp 9222     # every preview the toolbar reaches: no WebGPU error
node scripts/page-checks.mjs http://127.0.0.1:5173/ --cdp 9222  # wording, the loading bar, linked scrolling
```

Without WebGPU the page keeps everything but the preview, and Run runs the CPU executors alone. Check that in a Chrome
started with `--disable-features=WebGPU`, and again with `navigator.gpu` removed:

```sh
node scripts/page-checks.mjs http://127.0.0.1:5173/ --cdp 9222 --only fallback,wording
node scripts/page-checks.mjs http://127.0.0.1:5173/ --cdp 9222 --only fallback,wording --remove-gpu
```

The Coverage route is built in only where `docs/coverage/coverage.json` exists.

## Layout

- `glue/` is the `iridia-web` crate (not published, its own workspace). It reads a dropped file with dx's readers,
  lifts it through iridia's public pipeline and gives the page JSON reports. `ir.rs` is the IR path (Direct3D 9);
  `legacy.rs` holds what DXBC and DXIL still lift through until their readers are on the IR, so that it is deleted
  in one piece then (`tests/legacy.rs` is expected to fail until it is).
- `glue/tests/refused/` holds a program iridia refuses (not an example), for the tests of how a refusal reads.
- `examples/` holds the page's examples: our own HLSL beside each compiled program, and Microsoft's listing of it
  (`.ms.txt`), which the glue's tests compare dx's listings against. `examples/build.sh` recompiles them with fxc
  and dxc; the compiled files are committed, so the page's build needs neither compiler.
- `src/` is the page: `app.ts` the workspace for one shader or pair, `views/` its tabs, `gpu/` the WebGPU preview,
  `coverage.ts` the coverage table (from `docs/coverage/coverage.json` where it exists).
- `scripts/assets.mjs` copies what the page fetches at run time into `public/`.

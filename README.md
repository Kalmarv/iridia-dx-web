<h1>
  <img src="src/assets/iridia-logo.svg" alt="" height="36" align="center"> iridia + <img src="src/assets/dx-logo.svg" alt="" height="36" align="center"> dx in the browser
</h1>

**Try it: <https://kalmarv.github.io/iridia-dx-web/>**

Drop a compiled Direct3D shader (DXBC, DXIL or Direct3D 9) onto the page, or open one of its examples, and read it,
lift it and run it, all in the page as WebAssembly with no server:

- **Bytecode** ([dx](https://github.com/Kalmarv/dx)): the container's parts, the bytes, and the disassembly exactly as
  Microsoft's tools write it, each instruction tied to its bytes.
- **Lift, Specialise, Flow, Run** ([iridia](https://github.com/Kalmarv/iridia)): the program iridia lifts and the WGSL
  it writes, the program with its constants pinned, how each value reaches the output, and one pixel run on the CPU
  beside the GPU's.
- A live WebGPU preview on a screen quad or a mesh, with the program's constants and textures as controls. Without
  WebGPU everything but the preview works, and Run runs the CPU executors alone.

The marks are the projects' own: `src/assets/iridia-logo.svg` is iridia's `docs/logo.svg` and `src/assets/dx-logo.svg`
is dx's. Replace a copy when its project's changes.

## Running it locally

Needs Rust 1.99 with the `wasm32-unknown-unknown` target, wasm-pack 0.13, Node 24 and pnpm 10.

```sh
pnpm install
pnpm wasm      # the glue as wasm, into pkg/
pnpm dev       # a dev server on 127.0.0.1
pnpm build     # the page, into dist/ (relative paths: serve it from any folder)
```

WebGPU needs a secure context: serve the page from `localhost` (or HTTPS).

The glue's own checks, as CI runs them:

```sh
cd glue
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

## Browser checks

The page's browser checks run over the DevTools protocol in a Chrome with WebGPU started with
`--remote-debugging-port`. They wait on the workspace's `data-preview` state (starting, building, ready, failed or
none). `variants.mjs` also reads each preview's canvas back and fails if it is all the clear colour or one flat
colour. Run it in a headed Chrome under a virtual display: a headless Chrome does not composite WebGPU canvases, so
it shows a visitor a blank preview that a check can't see. On Linux:

```sh
xvfb-run -a google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/checks \
  --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --enable-gpu --ignore-gpu-blocklist &
node scripts/variants.mjs http://127.0.0.1:5173/ --cdp 9222     # every preview the toolbar reaches: drawn, no WebGPU error
node scripts/page-checks.mjs http://127.0.0.1:5173/ --cdp 9222  # wording, the loading bar, linked scrolling
```

Without WebGPU the page keeps everything but the preview. Check that in a Chrome started with
`--disable-features=WebGPU`, and again with `navigator.gpu` removed:

```sh
node scripts/page-checks.mjs http://127.0.0.1:5173/ --cdp 9222 --only fallback,wording
node scripts/page-checks.mjs http://127.0.0.1:5173/ --cdp 9222 --only fallback,wording --remove-gpu
```

The Coverage route is built in only where `coverage/coverage.json` (iridia's coverage table) exists.

## Layout

- `glue/` is the `iridia-web` crate (not published, its own Cargo workspace). It reads a dropped file with dx's
  readers from crates.io, lifts it through iridia's crates (from one commit of iridia's main branch) and gives the
  page JSON reports. `ir.rs` is the IR path: Direct3D 9 and DXBC programs lift onto iridia's IR, which gives the
  Lift view, the WGSL and the CPU runs (`iridia-exec-ir` interprets the IR, `iridia-exec` compiles it; `exec.rs` is the
  register view they share). `legacy.rs` holds what is not on the IR yet: DXIL and DXBC compute programs, and the
  Flow analyses and constant folding of DXBC and DXIL programs. It is deleted in one piece once those move
  (`tests/legacy.rs` is expected to fail until it is).
- `glue/tests/refused/` holds a program iridia refuses (not an example), for the tests of how a refusal reads.
- `examples/` holds the page's examples: our own HLSL beside each compiled program, and Microsoft's listing of it
  (`.ms.txt`), which the glue's tests compare dx's listings against. `examples/build.sh` recompiles them with fxc
  and dxc; the compiled files are committed, so the page's build needs neither compiler.
- `src/` is the page: `app.ts` the workspace for one shader or pair, `views/` its tabs, `gpu/` the WebGPU preview,
  `cpu.ts` the inputs the CPU runs take without a GPU, `coverage.ts` the coverage table.
- `scripts/assets.mjs` copies what the page fetches at run time into `public/`.
- `.github/workflows/pages.yml` builds the page from `main` and publishes it to GitHub Pages.

## License

GPL-3.0-or-later, as iridia, whose crates the page's WebAssembly is built from.

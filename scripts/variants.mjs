// node scripts/variants.mjs PAGE_URL [--cdp PORT] [--only ID,ID]: build every preview the page's controls can reach and
// fail on any WebGPU error. In a Chrome with WebGPU (started with --remote-debugging-port=PORT, default 9222), it opens
// each example and walks its toolbar as a visitor would: screen quad and mesh, each mesh, wireframe off and on, each
// shown output or target, and pause. After each change it waits for the workspace's data-preview to settle and a few
// frames to draw, then counts a failure if the preview shows an error or never settles, the page logs an error, or the
// preview drew nothing: its canvas, read back after the page's frame, is all the clear colour or one flat colour.
//
// Run it in a headed Chrome under a virtual display (xvfb-run -a google-chrome --remote-debugging-port=PORT
// --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan ...): a headless Chrome does not composite
// WebGPU canvases, so what a visitor sees is not what it reads back.
import { cli, connect, examples, SETTLE } from './browser.mjs';

const { page, flag, port } = cli('node scripts/variants.mjs PAGE_URL [--cdp PORT] [--only ID,ID]');
const only = flag('--only')?.split(',');
const b = await connect(port);
await b.open(page);
const ids = await examples(b);
if (!ids.length) throw new Error(`the page at ${page} lists no examples`);

/**
 * In the page: what the preview canvas shows after the page's next frame, read back through a 2D canvas: the share of
 * its pixels that are the renderer's clear colour (0.08, 0.08, 0.1) and the widest spread of any channel over the rest.
 */
const DRAWN = `function drawn() {
  return new Promise((done) => requestAnimationFrame(() => {
    const c = document.querySelector('.workspace canvas.preview-canvas');
    if (!c || !c.width || !c.height) return done({ error: 'no preview canvas' });
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    const g = copy.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const clear = [0.08 * 255, 0.08 * 255, 0.1 * 255];
    let background = 0;
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 255 && [0, 1, 2].every((k) => Math.abs(d[i + k] - clear[k]) <= 2)) { background++; continue; }
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], d[i + k]); hi[k] = Math.max(hi[k], d[i + k]); }
    }
    const pixels = d.length / 4;
    done({ pixels, background: background / pixels, spread: Math.max(0, ...[0, 1, 2].map((k) => hi[k] - lo[k])) });
  }));
}`;
/** At least this share of the canvas must be drawn over the clear colour, and the drawn part must vary this much. */
const MIN_DRAWN = 0.01;
const MIN_SPREAD = 16;

let checked = 0;
const failures = [];
async function check(example, what) {
  const r = await b.call(`async function () { ${SETTLE}; ${DRAWN}; const s = await settle(); return s.state === 'ready' ? { ...s, drawn: await drawn() } : s; }`);
  checked++;
  const errors = b.drain();
  if (r.drawn) {
    const d = r.drawn;
    if (d.error) errors.push(d.error);
    else if (1 - d.background < MIN_DRAWN) errors.push(`drew nothing: ${(d.background * 100).toFixed(1)}% of the canvas is the clear colour`);
    else if (d.spread < MIN_SPREAD) errors.push(`drew one flat colour: no channel varies by more than ${d.spread}`);
  }
  const shows = r.drawn && !r.drawn.error ? ` (${((1 - r.drawn.background) * 100).toFixed(0)}% drawn, spread ${r.drawn.spread})` : '';
  // a preview still starting or building after the wait never settled: a failure as much as a refusal
  if ((r.state !== 'ready' && r.state !== 'none') || errors.length) {
    failures.push({ example, what, state: r.state, message: r.message, errors });
    console.log(`FAIL ${example} · ${what}: ${r.state} ${r.message} ${errors.join(' | ')}`);
  } else console.log(`ok   ${example} · ${what}: ${r.state}${shows}`);
  return r.state;
}

/** Act on the toolbar (redrawn on each change, so found afresh): `step` names what to change. */
const act = (step) =>
  b.call(
    `async function (step) {
  const controls = () => {
    const bar = document.querySelector('.workspace .toolbar');
    const select = (label) => [...(bar?.querySelectorAll('label') ?? [])].find((l) => l.textContent.trim().startsWith(label))?.querySelector('select') ?? null;
    return {
      views: [...(bar?.querySelectorAll('button.seg') ?? [])],
      mesh: select('Mesh'),
      wire: [...(bar?.querySelectorAll('label.toggle') ?? [])].find((l) => /Wireframe/.test(l.textContent))?.querySelector('input') ?? null,
      out: select('Show') ?? select('Target'),
      pause: [...(bar?.querySelectorAll('button') ?? [])].find((b) => /^(Pause|Play)$/.test(b.textContent.trim())) ?? null,
    };
  };
  const c = controls();
  if (step.view !== undefined) c.views[step.view]?.click();
  if (step.mesh !== undefined && c.mesh) { c.mesh.value = step.mesh; c.mesh.dispatchEvent(new Event('change')); }
  if (step.wire !== undefined && c.wire && c.wire.checked !== step.wire) { c.wire.checked = step.wire; c.wire.dispatchEvent(new Event('change')); }
  if (step.out !== undefined && c.out) { c.out.value = step.out; c.out.dispatchEvent(new Event('change')); }
  if (step.pause) c.pause?.click();
  const n = controls();
  return { views: n.views.map((b) => b.textContent), meshes: n.mesh ? [...n.mesh.options].map((o) => o.value) : [], wire: !!n.wire, outs: n.out ? [...n.out.options].map((o) => o.value) : [], pause: !!n.pause };
}`,
    step,
  );

for (const ex of ids) {
  if (only && !only.includes(ex)) continue;
  await b.call(`async function (ex) { location.hash = '#/example/' + ex; }`, ex);
  if ((await check(ex, 'opened')) === 'none') continue;
  const first = await act({});
  const views = first.views.length ? first.views.map((_, i) => i) : [undefined];
  for (const view of views) {
    const v = view === undefined ? 'its view' : first.views[view];
    let c = await act({ view });
    await check(ex, v);
    for (const mesh of c.meshes.length ? c.meshes : [undefined]) {
      c = await act({ mesh });
      const m = mesh ? `${v}, ${mesh}` : v;
      await check(ex, m);
      for (const wire of c.wire ? [true, false] : []) {
        c = await act({ wire });
        await check(ex, `${m}, wireframe ${wire ? 'on' : 'off'}`);
      }
      if (c.wire) await act({ wire: true });
      for (const out of c.outs.length > 1 ? c.outs : []) {
        c = await act({ out });
        await check(ex, `${m}${c.wire ? ', wireframe' : ''}, output ${out}`);
      }
      if (c.outs.length > 1) await act({ out: c.outs[0] });
      if (c.pause) {
        await act({ pause: true });
        await check(ex, `${m}${c.wire ? ', wireframe' : ''}, paused`);
        await act({ pause: true });
      }
      if (c.wire) await act({ wire: false });
    }
  }
}
console.log(`\n${checked} states, ${failures.length} failing`);
b.close();
process.exit(failures.length ? 1 : 0);

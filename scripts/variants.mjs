// node scripts/variants.mjs PAGE_URL [--cdp PORT] [--only ID,ID]: build every preview the page's controls can reach and
// fail on any WebGPU error. In a Chrome with WebGPU (started with --remote-debugging-port=PORT, default 9222), it opens
// each example and walks its toolbar as a visitor would: screen quad and mesh, each mesh, wireframe off and on, each
// shown output or target, and pause. After each change it waits for the workspace's data-preview to settle and a few
// frames to draw, then counts a failure if the preview shows an error or never settles, or the page logs an error.
import { cli, connect, examples, SETTLE } from './browser.mjs';

const { page, flag, port } = cli('node scripts/variants.mjs PAGE_URL [--cdp PORT] [--only ID,ID]');
const only = flag('--only')?.split(',');
const b = await connect(port);
await b.open(page);
const ids = await examples(b);
if (!ids.length) throw new Error(`the page at ${page} lists no examples`);

let checked = 0;
const failures = [];
async function check(example, what) {
  const r = await b.call(`async function () { ${SETTLE}; return settle(); }`);
  checked++;
  const errors = b.drain();
  // a preview still starting or building after the wait never settled: a failure as much as a refusal
  if ((r.state !== 'ready' && r.state !== 'none') || errors.length) {
    failures.push({ example, what, state: r.state, message: r.message, errors });
    console.log(`FAIL ${example} · ${what}: ${r.state} ${r.message} ${errors.join(' | ')}`);
  } else console.log(`ok   ${example} · ${what}: ${r.state}`);
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

// node scripts/page-checks.mjs PAGE_URL [--cdp PORT] [--only wording,progress,scroll,fallback,coverage]: the page's
// checks in Chrome. In a Chrome without WebGPU (--disable-features=WebGPU: no adapter) run wording, fallback and coverage, and again with
// --remove-gpu, which deletes navigator.gpu before the page loads (as in a browser with no WebGPU at all).
//
// - wording: no text the page shows, on the examples route or any tab of any example (with every constant pinned and a
//   pixel run), names naga or says something is not yet done, unsupported or refused. The Coverage route is iridia's
//   table, whose outcomes are those words; the coverage check reads it instead.
// - coverage: the route shows the iridia commit the glue pins; each suite's totals are the table's, and they are its
//   selected runs alone (the extended ones apart); every outcome has its mark and label; every row but a pass gives
//   its reason; the feature and run filters work from the keyboard alone (Tab, Space, Enter, typing) and pick exactly
//   the rows the table holds for them. It needs no WebGPU: run it in the fallback Chromes too.
// - progress: once the glue has loaded the bar under the header is full or gone, however the server states the
//   download's length (exactly, as a total the bytes never reach, or not at all, as a compressing proxy does).
// - scroll: selecting a listing line brings its bytes into view in the bytes pane, centred; selecting bytes or a
//   region brings its line into the listing; at the start, middle and end of several examples, at desktop and phone
//   widths and after a resize. A wheel over a pane scrolls that pane only, the page scrolls outside them, nothing
//   scrolls back on its own, and the keyboard scrolls the focused listing.
// - fallback (a Chrome without WebGPU): each example opens with a note in place of the preview, not an error; every
//   tab shows its content with no error; Run runs the CPU executors and shows their outputs.
import { cli, connect, examples, SETTLE } from './browser.mjs';
import { iridiaRev } from './iridia.mjs';

const { page, flag, port } = cli('node scripts/page-checks.mjs PAGE_URL [--cdp PORT] [--only wording,progress,scroll,fallback,coverage]');
const only = flag('--only')?.split(',');
const b = await connect(port);
const failures = [];
const fail = (what, why) => {
  failures.push(`${what}: ${why}`);
  console.log(`FAIL ${what}: ${why}`);
};
const pass = (what) => console.log(`ok   ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const route = (hash) =>
  b.call(
    `async function (hash) { ${SETTLE};
  location.hash = hash;
  await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 300 && document.querySelector('.loading'); i++) await new Promise((r) => setTimeout(r, 50));
  if (document.querySelector('.workspace')) await settle();
  else await new Promise((r) => setTimeout(r, 300));
}`,
    hash,
  );
const tabs = () => b.call(`function () { return [...document.querySelectorAll('.workspace [role=tab]')].map((t) => t.id.replace('tab-', '')); }`);
const tab = (id) =>
  b.call(
    `async function (id) {
  document.getElementById('tab-' + id)?.click();
  for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
}`,
    id,
  );
const viewport = async (width, height, mobile = false) => {
  await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await sleep(300);
};

// ---- wording ----

const FORBIDDEN = /naga|not yet|unsupported|refused|not been generated|yet: /i;
async function wording(ids) {
  const shown = () => b.call(`function () { return document.body.innerText; }`);
  const look = async (what) => {
    const text = await shown();
    const lines = text.split('\n').filter((l) => FORBIDDEN.test(l));
    if (lines.length) fail(`wording · ${what}`, lines.slice(0, 4).map((l) => JSON.stringify(l.trim().slice(0, 160))).join(', '));
    else pass(`wording · ${what}`);
  };
  await route('#/');
  await look('#/');
  for (const ex of ids) {
    await route(`#/example/${ex}`);
    for (const t of await tabs()) {
      await tab(t);
      if (t === 'specialise') {
        // every constant pinned, one after another: each pin specialises again
        await b.call(`async function () {
          for (const box of document.querySelectorAll('.spec-pins input[type=checkbox]')) {
            if (!box.checked) { box.click(); await new Promise((r) => setTimeout(r, 30)); }
          }
          await new Promise((r) => setTimeout(r, 200));
        }`);
      }
      if (t === 'run') {
        // a pixel run: a click at the middle of the preview, or without WebGPU the CPU run's button
        await b.call(`async function () {
          const cpu = [...document.querySelectorAll('.tab-body button')].find((b) => b.textContent === 'Run on the CPU');
          if (cpu) { cpu.click(); await new Promise((r) => setTimeout(r, 300)); return; }
          const c = document.querySelector('.workspace canvas');
          if (!c) return;
          const r = c.getBoundingClientRect();
          const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1 };
          c.dispatchEvent(new PointerEvent('pointerdown', at));
          c.dispatchEvent(new PointerEvent('pointerup', at));
          c.dispatchEvent(new MouseEvent('click', at));
          const t0 = performance.now();
          await new Promise((r) => setTimeout(r, 300));
          while (performance.now() - t0 < 15000 && /Reading back/.test(document.querySelector('.tab-body')?.innerText ?? '')) await new Promise((r) => setTimeout(r, 100));
        }`);
      }
      await look(`${ex} · ${t}`);
    }
  }
}

// ---- fallback ----

async function fallback(ids) {
  const gpu = await b.call(`async function () { return !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null))); }`);
  if (gpu) {
    fail('fallback', 'this Chrome has a WebGPU adapter: start one with --disable-features=WebGPU');
    return;
  }
  pass(`fallback · ${(await b.call(`function () { return 'gpu' in navigator; }`)) ? 'navigator.gpu with no adapter' : 'no navigator.gpu'}`);
  for (const ex of ids) {
    await route(`#/example/${ex}`);
    const opened = await b.call(`function () {
      const m = document.querySelector('.workspace .preview-message');
      return { state: document.querySelector('.workspace')?.dataset.preview, note: !!m?.querySelector('.note-box'), error: m?.querySelector('.error-box')?.textContent ?? null, text: m?.textContent ?? '' };
    }`);
    if (opened.state !== 'none' || !opened.note || opened.error) fail(`fallback · ${ex} · preview`, `state ${opened.state}, ${opened.error ? `error: ${opened.error}` : `note: ${opened.note}`}`);
    else pass(`fallback · ${ex} · a note in place of the preview`);
    for (const t of await tabs()) {
      await tab(t);
      if (t === 'run') {
        await b.call(`async function () {
          [...document.querySelectorAll('.tab-body button')].find((b) => b.textContent === 'Run on the CPU')?.click();
          await new Promise((r) => setTimeout(r, 300));
        }`);
      }
      const r = await b.call(`function () {
        const body = document.querySelector('.workspace .tab-body');
        return { error: [...body.querySelectorAll('.error-box')].map((e) => e.textContent).join(' | '), length: body.innerText.trim().length, runCells: body.querySelectorAll('.run-table tbody td').length, columns: [...body.querySelectorAll('.run-table thead th')].map((t) => t.firstChild?.textContent) };
      }`);
      const what = `fallback · ${ex} · ${t}`;
      if (r.error) fail(what, r.error.slice(0, 200));
      else if (r.length < 20) fail(what, 'the tab is empty');
      else if (t === 'run' && !r.runCells) fail(what, 'no CPU run shown');
      else if (t === 'run' && r.columns.some((c) => /GPU/.test(c ?? ''))) fail(what, `a GPU column: ${r.columns}`);
      else pass(`${what}${t === 'run' ? `: ${r.columns.slice(1).join(', ')}` : ''}`);
    }
  }
}

// ---- coverage ----

/** Press `key` in the page as the keyboard does, with Shift when `shift`. */
async function press(key, shift = false) {
  const keys = { Tab: [9, 'Tab', ''], Space: [32, ' ', ' '], Enter: [13, 'Enter', '\r'] };
  const [code, name, text] = keys[key];
  const common = { key: name, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: shift ? 8 : 0 };
  await b.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text: text || undefined, ...common });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await sleep(40);
}
/** Tab (back with `back`) until the focused element matches `test` (a function's source taking it); the presses it took. */
async function tabTo(test, what, most = 60, back = false) {
  for (let i = 1; i <= most; i++) {
    await press('Tab', back);
    if (await b.call(`function () { return (${test})(document.activeElement); }`)) return i;
  }
  throw new Error(`Tab never reached ${what}`);
}
/** What the coverage page shows: totals by suite, each table's rows and its status line, and rows lacking a mark or a reason. */
const shownCoverage = () =>
  b.call(`function () {
    const rows = (sel) => [...document.querySelectorAll(sel + ' tbody tr')].map((tr) => {
      const o = tr.querySelector('.outcome');
      return { status: o?.dataset.status, mark: o?.querySelector('.mark')?.textContent ?? '', label: o?.textContent.replace(o.querySelector('.mark')?.textContent ?? '', '').trim(), cells: [...tr.cells].map((c) => c.textContent), extended: !!tr.querySelector('.tag') };
    });
    return {
      h1: document.querySelector('main h1')?.textContent,
      commit: document.querySelector('.coverage .lede a.mono')?.textContent,
      totals: Object.fromEntries([...document.querySelectorAll('.suite-totals')].map((s) => [s.querySelector('h3').textContent, Object.fromEntries([...s.querySelectorAll('.count')].map((c) => [c.querySelector('.outcome').dataset.status, Number(c.textContent.replace(/[^0-9]/g, ''))]))])),
      extendedNote: document.querySelector('.extended-note')?.textContent ?? '',
      features: rows('table.features'), runs: rows('table.runs'),
      featuresShown: document.querySelector('table.features')?.closest('section').querySelector('[role=status]')?.textContent,
      runsShown: document.querySelector('table.runs')?.closest('section').querySelector('[role=status]')?.textContent,
      errors: [...document.querySelectorAll('.coverage .error-box')].map((e) => e.textContent),
    };
  }`);

async function coverage() {
  await route('#/coverage');
  const table = await b.call(`async function () { return (await fetch('./coverage.json', { cache: 'no-store' })).json(); }`);
  const rev = iridiaRev();
  const tally = (rows) => rows.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  const same = (a, b) => JSON.stringify(Object.entries(a).filter(([, n]) => n).sort()) === JSON.stringify(Object.entries(b).filter(([, n]) => n).sort());
  const check = (what, ok, why) => (ok ? pass(`coverage · ${what}`) : fail(`coverage · ${what}`, why));
  let v = await shownCoverage();
  check('opens', v.h1 === 'Coverage' && !v.errors.length, `heading ${v.h1}, errors ${v.errors}`);
  check(`made at the pinned iridia ${rev.slice(0, 7)}`, v.commit === rev.slice(0, 7), `the page names ${v.commit}`);
  check('the table is schema version 1', table.version === 1, `version ${table.version}`);
  for (const s of table.suites) {
    const selected = s.rows.filter((r) => r.selected !== false);
    check(`${s.id} · totals are the table's selected runs (${selected.length} of ${s.rows.length})`, same(tally(selected), s.totals), `rows ${JSON.stringify(tally(selected))}, totals ${JSON.stringify(s.totals)}`);
    if (s.extended_totals) check(`${s.id} · extended totals are the other ${s.rows.length - selected.length} runs`, same(tally(s.rows.filter((r) => r.selected === false)), s.extended_totals), JSON.stringify(s.extended_totals));
    check(`${s.id} · the page shows those totals`, same(v.totals[s.name] ?? {}, s.totals), `shown ${JSON.stringify(v.totals[s.name])}`);
    const reasonless = s.rows.filter((r) => r.status !== 'pass' && !r.detail.trim());
    check(`${s.id} · every run but a pass has a reason in the table`, !reasonless.length, `${reasonless.length} without: ${reasonless.slice(0, 3).map((r) => r.id)}`);
  }
  const vk = table.suites.find((s) => s.extended_totals);
  const extended = vk ? vk.rows.length - vk.rows.filter((r) => r.selected !== false).length : 0;
  check('the extended runs are said to be left out of the totals', !vk || (v.extendedNote.includes('Not counted') && v.extendedNote.includes(extended.toLocaleString('en-US'))), v.extendedNote);
  const marked = (rows, what) => {
    const bad = rows.filter((r) => !r.status || !r.mark.trim() || !r.label);
    const reasonless = rows.filter((r) => r.status !== 'pass' && /^(—|)$/.test(r.cells.at(-1).trim()));
    check(`${what} · ${rows.length} rows each with a mark and a label, and a reason but for a pass`, rows.length && !bad.length && !reasonless.length, `${rows.length} rows; no mark or label: ${bad.length}; no reason: ${reasonless.slice(0, 3).map((r) => r.cells[1])}`);
  };
  marked(v.features, 'features');
  check(`features · all ${table.features.length} shown to start`, v.features.length === table.features.length, `${v.features.length} rows, ${v.featuresShown}`);

  // the features' filters by keyboard: Tab to the Stages button and press Enter, then type in their search box
  await b.call(`function () { document.activeElement?.blur(); window.scrollTo(0, 0); }`);
  await tabTo(`(e) => e?.matches?.('button.seg') && e.textContent === 'Stages'`, 'the Stages button');
  await press('Enter');
  v = await shownCoverage();
  const stages = table.features.filter((f) => f.kind === 'stage');
  check(`features · Stages by keyboard: the ${stages.length} stage rows`, v.features.length === stages.length && v.features.every((r) => r.cells[3] === 'stage'), `${v.features.length} rows: ${v.featuresShown}`);
  await tabTo(`(e) => e?.matches?.('input[type=search][aria-label="Filter features"]')`, 'the features search');
  await b.send('Input.insertText', { text: 'ps_' });
  await sleep(200);
  v = await shownCoverage();
  const ps = stages.filter((f) => f.name.toLowerCase().includes('ps_'));
  check(`features · typing “ps_”: the ${ps.length} pixel stages`, ps.length && v.features.length === ps.length && v.features.every((r) => r.cells[1].includes('ps_')), `${v.features.length} rows: ${v.features.map((r) => r.cells[1])}`);

  // the runs: passes hidden and the extended runs left out to start
  const nonPass = (rows) => rows.filter((r) => r.status !== 'pass');
  const expectShown = (count) => (count > 400 ? `400 runs shown of the ${count.toLocaleString('en-US')} picked: filter to see the rest.` : `${count} run${count === 1 ? '' : 's'} shown.`);
  const first = table.suites[0];
  const start = nonPass(first.rows.filter((r) => r.selected !== false)).length;
  v = await shownCoverage();
  check(`runs · ${first.id} to start: its ${start} selected runs but the passes`, v.runsShown === expectShown(start) && v.runs.every((r) => r.status !== 'pass' && !r.extended), v.runsShown);
  marked(v.runs, `runs · ${first.id}`);
  if (vk === first) {
    await tabTo(`(e) => e?.matches?.('input[type=checkbox]') && e.parentElement.textContent.trim() === 'Extended runs'`, 'the Extended runs box');
    await press('Space');
    v = await shownCoverage();
    const all = nonPass(first.rows).length;
    check(`runs · Extended runs by keyboard: ${all} runs but the passes`, v.runsShown === expectShown(all) && v.runs.some((r) => r.extended), v.runsShown);
  }
  await tabTo(`(e) => e?.matches?.('fieldset.outcomes input[value=pass]') && e.closest('section').querySelector('table.runs')`, 'the runs’ pass box');
  await press('Space');
  v = await shownCoverage();
  check(`runs · pass ticked by keyboard: all ${first.rows.length}`, v.runsShown === expectShown(first.rows.length), v.runsShown);
  const term = 'texture';
  const back = await tabTo(`(e) => e?.getAttribute?.('aria-label') === ${JSON.stringify(`Filter ${first.id} runs`)}`, 'the runs search', 20, true);
  await b.send('Input.insertText', { text: term });
  await sleep(200);
  v = await shownCoverage();
  const matching = first.rows.filter((r) => `${r.case} ${r.model} ${r.detail}`.toLowerCase().includes(term)).length;
  check(`runs · Shift+Tab ${back} back to the search, typing “${term}”: ${matching} runs`, v.runsShown === expectShown(matching), v.runsShown);
  // the other suite, by keyboard from the Suite buttons
  for (const s of table.suites.slice(1)) {
    await b.call(`function () { document.querySelector('[role=group][aria-label=Suite] button')?.focus(); }`);
    const at = await tabTo(`(e) => e?.matches?.('[role=group][aria-label=Suite] button') && e.textContent === ${JSON.stringify(s.name)}`, s.name, 5);
    await press('Enter');
    v = await shownCoverage();
    const count = nonPass(s.rows).length;
    check(`runs · ${s.id} by keyboard (${at} Tab): its ${count} runs but the passes`, v.runsShown === expectShown(count) && v.runs.every((r) => r.status !== 'pass'), v.runsShown);
    marked(v.runs, `runs · ${s.id}`);
  }
  const logged = b.drain();
  check('nothing logged as an error', !logged.length, logged.slice(0, 3).join(' | '));
}

// ---- progress ----

async function progress() {
  // the wasm's response, its length stated as `length(size)` says
  const cases = [
    ['the exact length', (n) => n],
    ['a length the bytes never reach', (n) => Math.round(n * 1.3)],
    ['no length', () => null],
  ];
  await b.send('Network.enable');
  await b.send('Network.setCacheDisabled', { cacheDisabled: true });
  for (const [what, length] of cases) {
    await b.send('Fetch.enable', { patterns: [{ urlPattern: '*.wasm', requestStage: 'Response' }] });
    let off;
    const intercepted = new Promise((resolve) => {
      off = b.on(async (d) => {
        if (d.method !== 'Fetch.requestPaused') return;
        const body = await b.send('Fetch.getResponseBody', { requestId: d.params.requestId });
        const bytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
        const headers = d.params.responseHeaders.filter((h) => !/^content-length$/i.test(h.name));
        const n = length(bytes.length);
        if (n !== null) headers.push({ name: 'Content-Length', value: String(n) });
        // a stated length longer than the body: Chrome ends the body at its own end all the same
        await b.send('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: headers, body: bytes.toString('base64') });
        resolve();
      });
    });
    await b.open(page);
    // the home page loads the glue when idle; an example needs it at once
    await b.call(`async function () { location.hash = '#/example/plasma'; }`);
    await Promise.race([intercepted, sleep(20000)]);
    off();
    await b.send('Fetch.disable');
    await b.call(`async function () { ${SETTLE}; await settle(); await new Promise((r) => setTimeout(r, 900)); }`);
    const bar = await b.call(`function () {
      const track = document.querySelector('.progress'), bar = document.querySelector('.progress-bar');
      const cs = getComputedStyle(bar);
      return { opacity: Number(cs.opacity), width: bar.getBoundingClientRect().width, track: track.getBoundingClientRect().width, display: cs.display };
    }`);
    const gone = bar.opacity === 0 || bar.display === 'none' || bar.width === 0;
    const full = bar.width >= bar.track - 1;
    if (gone || full) pass(`progress · ${what}: ${gone ? 'gone' : 'full'}`);
    else fail(`progress · ${what}`, `the bar is left at ${Math.round((bar.width / bar.track) * 100)}% (${bar.width} of ${bar.track} px), opacity ${bar.opacity}`);
  }
  await b.send('Network.setCacheDisabled', { cacheDisabled: false });
}

// ---- scroll ----

// In the page: helpers over the Bytecode tab's two panes.
const PANES = `
  const hexPane = document.querySelector('.bytecode .hex');
  const listing = document.querySelector('.bytecode .code');
  const settled = async (el) => {
    let last = -1, same = 0;
    for (let i = 0; i < 200 && same < 6; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (el.scrollTop === last) same++; else { same = 0; last = el.scrollTop; }
    }
  };
  /** How \`rows\` (first and last) sit in \`pane\`: visible, and how far their middle is from the pane's. */
  const placement = (pane, first, last) => {
    const p = pane.getBoundingClientRect(), a = first.getBoundingClientRect(), z = last.getBoundingClientRect();
    const top = p.top + pane.clientTop, bottom = top + pane.clientHeight;
    const fits = z.bottom - a.top <= pane.clientHeight;
    // at either end of its scroll the pane cannot centre what is near that end
    const clamped = pane.scrollTop <= 0 || pane.scrollTop >= pane.scrollHeight - pane.clientHeight - 1;
    return { visible: fits ? a.top >= top - 1 && z.bottom <= bottom + 1 : a.top >= top - 1 && a.top < bottom, off: Math.abs((a.top + z.bottom) / 2 - (top + bottom) / 2), fits, clamped, row: a.height };
  };
`;

/** Click the middle of the element `select` names (a CSS selector and an index) with real mouse input. */
async function click(selector, index) {
  const at = await b.call(
    `async function ([selector, index]) {
    const el = document.querySelectorAll(selector)[index];
    if (!el) return null;
    // bring it into the window (not into its pane, which the caller has scrolled already)
    const r0 = el.getBoundingClientRect();
    if (r0.top < 60 || r0.bottom > innerHeight) window.scrollBy(0, r0.top - innerHeight / 2);
    await new Promise((r) => requestAnimationFrame(r));
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 8), y: r.top + r.height / 2 };
  }`,
    [selector, index],
  );
  if (!at) return false;
  for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  return true;
}

async function scrollChecks(ids, label) {
  for (const ex of ids) {
    await route(`#/example/${ex}`);
    await tab('bytecode');
    const rows = await b.call(`function () { return [...document.querySelectorAll('.bytecode .code-row')].map((r, i) => r.classList.contains('linked') ? i : -1).filter((i) => i >= 0); }`);
    if (!rows.length) {
      pass(`scroll ${label} · ${ex}: no listing line tied to bytes (DXIL)`);
      continue;
    }
    // listing -> bytes, at the start, middle and end
    for (const [where, line] of [['first', rows[0]], ['middle', rows[rows.length >> 1]], ['last', rows[rows.length - 1]]]) {
      await b.call(`async function (line) { ${PANES}
        const row = listing.querySelectorAll('.code-row')[line];
        listing.scrollTop = row.offsetTop - listing.clientHeight / 2 + (row.offsetParent === listing ? 0 : -listing.offsetTop);
        hexPane.scrollTop = 0;
        // the bytes pane starts far from the line's bytes: at its end for the first line, its start otherwise
        if (line < 3) hexPane.scrollTop = hexPane.scrollHeight;
        await settled(listing); await settled(hexPane);
      }`, line);
      // the row must be in the listing's view for a real click: put it there by its rect
      await b.call(`async function (line) { ${PANES}
        const row = listing.querySelectorAll('.code-row')[line];
        listing.scrollTop += row.getBoundingClientRect().top - listing.getBoundingClientRect().top - listing.clientHeight / 2;
        await settled(listing);
      }`, line);
      await click('.bytecode .code-row', line);
      const r = await b.call(`async function () { ${PANES}
        await settled(hexPane);
        const hl = [...hexPane.querySelectorAll('.hex-byte.hl')];
        if (!hl.length) return { none: true, status: document.querySelector('.bytecode .status').textContent };
        const p = placement(hexPane, hl[0].parentElement, hl[hl.length - 1].parentElement);
        const status = document.querySelector('.bytecode .status').textContent;
        const m = status.match(/0x([0-9A-F]+)\\D+0x([0-9A-F]+)/);
        return { ...p, status, first: Number(hl[0].dataset.b), last: Number(hl[hl.length - 1].dataset.b), range: m ? [parseInt(m[1], 16), parseInt(m[2], 16)] : null };
      }`);
      const what = `scroll ${label} · ${ex} · listing line ${line + 1} (${where}) -> bytes`;
      if (r.none) fail(what, `no bytes marked (${r.status})`);
      else if (!r.range || r.range[0] !== r.first || r.range[1] !== r.last) fail(what, `marked bytes ${r.first}..${r.last} but the status says ${r.status}`);
      else if (!r.visible) fail(what, `the marked bytes (${r.status}) are out of the bytes pane's view`);
      else if (r.fits && !r.clamped && r.off > r.row * 1.5) fail(what, `the marked bytes are ${Math.round(r.off)} px from the pane's middle`);
      else pass(`${what}: in view${r.fits ? `, ${Math.round(r.off)} px from the middle` : ''}`);
    }
    // bytes -> listing: a byte of the last and the first instruction, with the listing scrolled away from it
    for (const [where, line] of [['last', rows[rows.length - 1]], ['first', rows[0]]]) {
      const cell = await b.call(`async function ([line, where]) { ${PANES}
        listing.scrollTop = where === 'last' ? 0 : listing.scrollHeight;
        await settled(listing);
        // the instruction's first byte: found by clicking its line once, then the pane is scrolled to it
        const row = listing.querySelectorAll('.code-row')[line];
        row.click();
        await settled(hexPane);
        const hl = hexPane.querySelector('.hex-byte.hl');
        listing.scrollTop = where === 'last' ? 0 : listing.scrollHeight;
        await settled(listing);
        return hl ? [...hexPane.querySelectorAll('.hex-byte')].indexOf(hl) : -1;
      }`, [line, where]);
      if (cell < 0) {
        fail(`scroll ${label} · ${ex} · bytes -> listing (${where})`, 'no byte of the instruction found');
        continue;
      }
      await click('.bytecode .hex-byte', cell);
      const r = await b.call(`async function () { ${PANES}
        await settled(listing);
        const row = listing.querySelector('.code-row.hl');
        return row ? { ...placement(listing, row, row), line: [...listing.querySelectorAll('.code-row')].indexOf(row) } : null;
      }`);
      const what = `scroll ${label} · ${ex} · byte of line ${line + 1} (${where}) -> listing`;
      if (!r) fail(what, 'no listing line marked');
      else if (r.line !== line) fail(what, `marked line ${r.line + 1}`);
      else if (!r.visible) fail(what, 'the marked line is out of the listing\'s view');
      else pass(`${what}: in view`);
    }
    // a region: its bytes into view, and its first instruction into the listing
    const regions = await b.call(`function () { return document.querySelectorAll('.bytecode .region').length; }`);
    for (let i = 0; i < regions; i++) {
      await b.call(`async function () { ${PANES} hexPane.scrollTop = hexPane.scrollHeight; listing.scrollTop = listing.scrollHeight; await settled(hexPane); await settled(listing); }`);
      await click('.bytecode .region', i);
      const r = await b.call(`async function () { ${PANES}
        await settled(hexPane); await settled(listing);
        const hl = [...hexPane.querySelectorAll('.hex-byte.hl')];
        const label = document.querySelectorAll('.bytecode .region-label')[${i}]?.textContent;
        if (!hl.length) return { label, none: true };
        return { label, ...placement(hexPane, hl[0].parentElement, hl[hl.length - 1].parentElement) };
      }`);
      const what = `scroll ${label} · ${ex} · region ${r.label}`;
      if (r.none) fail(what, 'no bytes marked');
      else if (!r.visible) fail(what, 'its bytes are out of the bytes pane\'s view');
      else pass(`${what}: in view`);
    }
  }
}

async function wheelAndKeys(ex, label) {
  await route(`#/example/${ex}`);
  await tab('bytecode');
  // nothing scrolls back on its own: both panes held mid-way while the preview animates
  const held = await b.call(`async function () { ${PANES}
    window.scrollTo(0, 0);
    hexPane.scrollTop = hexPane.scrollHeight / 2; listing.scrollTop = listing.scrollHeight / 2;
    const at = [hexPane.scrollTop, listing.scrollTop];
    await new Promise((r) => setTimeout(r, 2000));
    return { at, now: [hexPane.scrollTop, listing.scrollTop] };
  }`);
  if (held.at[0] !== held.now[0] || held.at[1] !== held.now[1]) fail(`scroll ${label} · ${ex} · held`, `the panes moved from ${held.at} to ${held.now}`);
  else pass(`scroll ${label} · ${ex} · panes hold still for 2 s`);
  // a wheel over each pane scrolls it alone
  for (const pane of ['.bytecode .hex', '.bytecode .code']) {
    const before = await b.call(`async function (sel) {
      const el = document.querySelector(sel);
      el.scrollTop = 0;
      const r0 = el.getBoundingClientRect();
      window.scrollBy(0, r0.top - 80);
      await new Promise((r) => requestAnimationFrame(r));
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 100), pane: el.scrollTop, page: scrollY };
    }`, pane);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY: 240 });
    await sleep(500);
    const after = await b.call(`function (sel) { return { pane: document.querySelector(sel).scrollTop, page: scrollY }; }`, pane);
    const what = `scroll ${label} · ${ex} · wheel over ${pane}`;
    if (after.pane <= before.pane) fail(what, `the pane did not scroll (${before.pane} -> ${after.pane})`);
    else if (after.page !== before.page) fail(what, `the page scrolled too (${before.page} -> ${after.page})`);
    else pass(`${what}: the pane scrolled ${after.pane - before.pane} px, the page stayed`);
  }
  // a wheel outside the panes scrolls the page
  const outside = await b.call(`async function () {
    window.scrollTo(0, 0);
    await new Promise((r) => requestAnimationFrame(r));
    const h = document.querySelector('.bytecode-side h3').getBoundingClientRect();
    return { x: h.left + 10, y: h.top + h.height / 2, page: scrollY, room: document.documentElement.scrollHeight - innerHeight };
  }`);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: outside.x, y: outside.y, deltaX: 0, deltaY: 240 });
  await sleep(500);
  const page2 = await b.call(`function () { return scrollY; }`);
  if (outside.room > 0 && page2 === outside.page) fail(`scroll ${label} · ${ex} · wheel outside the panes`, 'the page did not scroll');
  else pass(`scroll ${label} · ${ex} · wheel outside the panes scrolls the page (${outside.page} -> ${page2})`);
  // the keyboard scrolls the focused listing
  const k0 = await b.call(`async function () { ${PANES} window.scrollTo(0, 0); listing.scrollTop = 0; listing.focus(); await settled(listing); return { pane: listing.scrollTop, page: scrollY }; }`);
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'PageDown']) {
    const code = { ArrowDown: 40, PageDown: 34 }[key];
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
  }
  const k1 = await b.call(`async function () { ${PANES} await settled(listing); return { pane: listing.scrollTop, page: scrollY, focused: document.activeElement === listing }; }`);
  const what = `scroll ${label} · ${ex} · arrow and page keys in the listing`;
  if (k1.pane <= k0.pane) fail(what, `the listing did not scroll (${k0.pane} -> ${k1.pane}, focused ${k1.focused})`);
  else if (k1.page !== k0.page) fail(what, `the page scrolled too (${k0.page} -> ${k1.page})`);
  else pass(`${what}: ${k0.pane} -> ${k1.pane}`);
}

if (flag('--remove-gpu') !== undefined || process.argv.includes('--remove-gpu')) await b.send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete Navigator.prototype.gpu;' });
await b.open(page);
const ids = await examples(b);
// fallback needs a Chrome without WebGPU: run only when asked for
const want = (s) => (only ? only.includes(s) : s !== 'fallback');
if (want('wording')) {
  await viewport(1400, 900);
  await wording(ids);
}
if (want('scroll')) {
  const some = ids.filter((id) => ['plasma', 'lit-brick', 'd3d9-pair', 'd3d9-ps2', 'd3d9-ps1', 'compute-fractal', 'post'].includes(id));
  await viewport(1400, 900);
  await scrollChecks(some, 'desktop');
  await wheelAndKeys('plasma', 'desktop');
  await viewport(1000, 800);
  await scrollChecks(['plasma', 'd3d9-pair'], 'after a resize to 1000');
  await viewport(390, 844, true);
  await scrollChecks(['plasma', 'lit-brick'], 'phone');
  await wheelAndKeys('plasma', 'phone');
}
if (want('fallback')) {
  await viewport(1400, 900);
  await fallback(ids);
}
if (want('coverage')) {
  await viewport(1400, 900);
  await coverage();
}
if (want('progress')) {
  await viewport(1400, 900);
  await progress();
}
await b.send('Emulation.clearDeviceMetricsOverride');
console.log(`\n${failures.length} failing`);
b.close();
process.exit(failures.length ? 1 : 0);

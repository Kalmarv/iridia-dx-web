// The page: a header, the routes (#/ the examples and the drop zone, #/example/<id>, #/file for a dropped file,
// #/coverage), the drag-and-drop over the whole window and the glue's lazy load.
import './style.css';
import { type Opened, Workspace, fetchExample } from './app';
import { coverageView } from './coverage';
import { h, plural } from './dom';
import { byId, EXAMPLES } from './examples';
import type { Report } from './types';
import { glue, onProgress } from './wasm';

const REPO = 'https://github.com/Kalmarv/iridia';
const CRATES = 'https://crates.io/crates/iridia';

const app = document.getElementById('app')!;
const main = h('main#main', { tabIndex: -1 });
const progress = h('div.progress', { role: 'progressbar', 'aria-label': 'loading iridia', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div.progress-bar'));
const dropOverlay = h('div.drop-overlay', { 'aria-hidden': 'true' }, h('div', h('strong', 'Drop to open'), h('span', 'a compiled shader (.cso .fxo .vso .pso .dxbc .dxil), or a vertex and a pixel program together')));
let workspace: Workspace | null = null;
let dropped: Opened[] | null = null;

const MOON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z" fill="currentColor"/></svg>';
const SUN =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** The theme switch: it shows the theme it switches to. */
function themeButton(): HTMLElement {
  const b = h('button.ghost.icon', { type: 'button' });
  const show = () => {
    const dark = document.documentElement.dataset.theme !== 'light';
    b.innerHTML = dark ? SUN : MOON;
    b.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
    b.title = b.getAttribute('aria-label')!;
  };
  b.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('iridia-theme', next);
    show();
  });
  show();
  return b;
}

const header = h(
  'header.top',
  h('a.brand', { href: '#/' }, h('span.logo', { 'aria-hidden': 'true' }), 'iridia'),
  h('p.tagline', 'iridia reads compiled Direct3D shaders and lifts them into programs other tools can read, write and run. Here it runs in your browser.'),
  h(
    'nav.links',
    h('a', { href: '#/coverage' }, 'Coverage'),
    h('a', { href: REPO, rel: 'noopener' }, 'GitHub'),
    h('a', { href: CRATES, rel: 'noopener' }, 'crates.io'),
    h('label.button.small', { htmlFor: 'open-file' }, 'Open…'),
    h('input.visually-hidden#open-file', { type: 'file', multiple: true, accept: '.cso,.fxo,.vso,.pso,.dxbc,.dxil,.bin,.fxc,.obj', on: { change: (e: Event) => openFiles([...((e.target as HTMLInputElement).files ?? [])]) } }),
    themeButton(),
  ),
);
app.append(header, progress, main, dropOverlay);

onProgress((loaded, total) => {
  progress.classList.add('active');
  const pct = total ? Math.min(100, (loaded / total) * 100) : 50;
  (progress.firstChild as HTMLElement).style.width = `${pct}%`;
  progress.setAttribute('aria-valuenow', String(Math.round(pct)));
});

async function loadGlue() {
  progress.classList.add('active');
  try {
    return await glue();
  } finally {
    progress.classList.remove('active');
  }
}

function home(): HTMLElement {
  const pick = h('label.button', { htmlFor: 'open-file' }, 'Choose files');
  return h(
    'div.home',
    h(
      'section.dropzone',
      { 'aria-label': 'open a shader' },
      h('div.dropzone-art', { 'aria-hidden': 'true' }),
      h('h1', 'Drop a compiled shader'),
      h('p', 'DXBC (Shader Model 4 and 5), DXIL (6.x) or a Direct3D 9 token stream (1.1 to 3.0): .cso, .fxo, .vso, .pso or a container. Drop a vertex and a pixel program together to link them.'),
      h('p', pick, h('span.dim', ' · nothing leaves your machine: it all runs here, in WebAssembly and WebGPU.')),
    ),
    h('h2', 'Or start from an example'),
    h(
      'ul.gallery',
      EXAMPLES.map((e) =>
        h(
          'li',
          h(
            'a.card',
            { href: `#/example/${e.id}` },
            h(`span.card-art.art-${e.id}`, { 'aria-hidden': 'true' }),
            h('span.card-title', e.title),
            h('span.card-summary', e.summary),
          ),
        ),
      ),
    ),
    h('p.dim.small', 'Every example is our own HLSL or assembly, compiled with fxc, dxc or D3DAssemble; the source ships beside each program.'),
  );
}

function loading(text: string): HTMLElement {
  return h('div.loading', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text));
}

function failure(title: string, detail: string): HTMLElement {
  return h('div.page-error', h('h1', title), h('div.error-box', detail), h('p', h('a', { href: '#/' }, 'Back to the examples')));
}

async function open(files: { name: string; bytes: Uint8Array }[]): Promise<Opened[]> {
  const Shader = await loadGlue();
  return files.map((f) => {
    let shader;
    try {
      shader = new Shader(f.bytes);
    } catch (e) {
      throw new Error(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const report = JSON.parse(shader.report()) as Report;
    return { name: f.name, bytes: f.bytes, shader, report };
  });
}

async function openFiles(files: File[]): Promise<void> {
  const shaders = files.filter((f) => !f.type.startsWith('image/'));
  if (!shaders.length) return;
  if (shaders.length > 2) {
    show(failure('Too many files', `Drop one program, or a vertex and a pixel program together: these are ${plural(shaders.length, 'file')}.`));
    return;
  }
  show(loading(`Reading ${shaders.map((f) => f.name).join(' and ')}…`));
  try {
    const bytes = await Promise.all(shaders.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const opened = await open(bytes);
    if (opened.length === 2) {
      const stages = opened.map((o) => o.report.interface?.stage).sort();
      if (stages.join() !== 'pixel,vertex') {
        opened.forEach((o) => o.shader.free());
        show(failure('Not a pair', `Two files open as a vertex and a pixel program; these are ${opened.map((o) => `${o.name} (${o.report.interface?.stage ?? o.report.refusal?.message ?? 'not lifted'})`).join(' and ')}.`));
        return;
      }
    }
    dropped = opened;
    if (location.hash === '#/file') route();
    else location.hash = '#/file';
  } catch (e) {
    show(failure('This file did not open', e instanceof Error ? e.message : String(e)));
  }
}

function show(el: HTMLElement): void {
  workspace?.destroy();
  workspace = null;
  main.replaceChildren(el);
}

let routeId = 0;
async function route(): Promise<void> {
  const id = ++routeId;
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, arg] = hash.split('/');
  document.title = 'iridia · compiled shaders in the browser';
  if (kind === 'example' && arg) {
    const ex = byId(arg);
    if (!ex) return show(failure('No such example', `There is no example named “${arg}”.`));
    show(loading(`Opening ${ex.title}…`));
    try {
      const { files, sources } = await fetchExample(ex);
      const opened = await open(files);
      if (id !== routeId) return opened.forEach((o) => o.shader.free());
      workspace?.destroy();
      workspace = new Workspace(opened, sources, ex);
      main.replaceChildren(workspace.el);
      document.title = `${ex.title} · iridia`;
    } catch (e) {
      if (id === routeId) show(failure(`${ex.title} did not open`, e instanceof Error ? e.message : String(e)));
    }
    return;
  }
  if (kind === 'file') {
    if (!dropped) return show(home());
    workspace?.destroy();
    workspace = new Workspace(dropped, [], null);
    dropped = null;
    main.replaceChildren(workspace.el);
    return;
  }
  if (kind === 'coverage') {
    show(loading('Reading the coverage table…'));
    const el = await coverageView();
    if (id === routeId) show(el);
    document.title = 'Coverage · iridia';
    return;
  }
  show(home());
  // fetch the glue while the visitor looks at the examples
  requestIdleCallback?.(() => void loadGlue().catch(() => undefined));
}

window.addEventListener('hashchange', () => void route());

let depth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  depth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  depth = Math.max(0, depth - 1);
  if (!depth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  depth = 0;
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) void openFiles(files);
});

void route();

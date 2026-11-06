// The workspace: one opened program (or a vertex and pixel pair), its report, the preview and the tabs.
import { type Buffer, buffers as makeBuffers, pinWords, requestBuffers, setLanes, setMatrix, floatBits } from './constants';
import { constantControls, type Slot, textureSlots } from './controls';
import { h, plural } from './dom';
import type { Example } from './examples';
import { exampleUrl } from './examples';
import { multiply, Orbit, transformPoint } from './gpu/math';
import { mesh as meshOf, MESHES, type Mesh } from './gpu/mesh';
import { type Camera, type Program, Preview, type Scene } from './gpu/renderer';
import { fromFile, guess, placeholder, type Pixels } from './gpu/textures';
import { defaultFeed, type Feed, FEEDS } from './gpu/wgsl';
import type { Executed, Io, Linked, Pins, Report, Request, Result, Specialisations, Wgsl } from './types';
import { err, ok } from './types';
import { bytecodeView } from './views/bytecode';
import { codePane } from './views/code';
import { flowView } from './views/flow';
import { interfaceView } from './views/interface';
import { liftView } from './views/lift';
import { type PixelRun, runView } from './views/run';
import { fieldKey, type SpecialiseState, specialiseView } from './views/specialise';
import type { Shader } from './wasm';

export interface Opened {
  name: string;
  bytes: Uint8Array;
  shader: Shader;
  report: Report;
}

interface Prog extends Opened {
  buffers: Buffer[];
  spec: SpecialiseState;
  specialised: Specialisations | null;
  specError: string | null;
}

const TABS = ['source', 'bytecode', 'interface', 'lift', 'specialise', 'flow', 'run'] as const;
type Tab = (typeof TABS)[number];
const TAB_NAMES: Record<Tab, string> = {
  source: 'Source',
  bytecode: 'Bytecode',
  interface: 'Interface',
  lift: 'Lift',
  specialise: 'Specialise',
  flow: 'Flow',
  run: 'Run',
};

let preview: Preview | string | null = null;
let previewCanvas: HTMLCanvasElement | null = null;
async function getPreview(): Promise<Preview | string> {
  if (preview) return preview;
  previewCanvas = h('canvas.preview-canvas', { 'aria-label': 'live preview' });
  preview = await Preview.create(previewCanvas).catch((e) => `WebGPU failed to start: ${e instanceof Error ? e.message : e}`);
  return preview;
}

const stageOf = (r: Report): string | null => r.interface?.stage ?? null;

export class Workspace {
  readonly el: HTMLElement;
  private progs: Prog[];
  private focus = 0;
  private tab: Tab = 'bytecode';
  private sources: { name: string; text: string }[];
  private example: Example | null;
  private linked: Result<Linked> | null = null;
  private orbit = new Orbit();
  private meshName: (typeof MESHES)[number];
  private quad: boolean;
  private wireframe = false;
  private feeds: Feed[] = [];
  private shown: number | null = null;
  private target = 0;
  private start = performance.now();
  private paused = false;
  private pausedAt = 0;
  private mouse: [number, number] = [0.5, 0.5];
  private textures = new Map<number, Pixels>();
  private run: PixelRun | null = null;
  private runError: string | null = null;
  /** What a run in progress reads back, for the Run tab and toast; null when none is running. */
  private running: string | null = null;
  private alive = true;
  private previewMessage = h('div.preview-message');
  private tabBody = h('div.tab-body', { role: 'tabpanel' });
  private tabList = h('div.tabs', { role: 'tablist', 'aria-label': 'views of the program' });
  private side = h('div.preview-side');
  private toast = h('div.toast', { role: 'status', 'aria-live': 'polite' });
  private specView: ReturnType<typeof specialiseView> | null = null;
  private frameId = 0;
  private dragging: { x: number; y: number; moved: boolean } | null = null;

  constructor(opened: Opened[], sources: { name: string; text: string }[], example: Example | null) {
    this.example = example;
    this.sources = sources;
    // a pair: the vertex program first
    opened.sort((a, b) => (stageOf(a.report) === 'vertex' ? -1 : 0) - (stageOf(b.report) === 'vertex' ? -1 : 0));
    this.progs = opened.map((o) => this.prepare(o));
    if (this.progs.length === 2) {
      // the pixel program is the one a pixel click runs, and the one shown first
      this.focus = 1;
      const [vs, ps] = this.progs;
      try {
        this.linked = JSON.parse(vs.shader.link(ps.shader));
      } catch (e) {
        this.linked = { Err: String(e) };
      }
    }
    this.meshName = example?.mesh ?? 'sphere';
    // a pixel program alone draws on a screen quad; a pair draws through its vertex program, on a mesh
    this.quad = (example?.view ?? (stageOf(this.primary.report) === 'pixel' && this.progs.length === 1 ? 'quad' : 'mesh')) === 'quad';
    this.tab = this.primary.report.refusal ? 'bytecode' : 'lift';
    this.el = h('div.workspace');
    this.render();
    void this.startPreview();
  }

  destroy(): void {
    this.alive = false;
    cancelAnimationFrame(this.frameId);
    for (const p of this.progs) p.shader.free();
  }

  private get primary(): Prog {
    return this.progs[this.progs.length - 1];
  }

  private get focused(): Prog {
    return this.progs[this.focus];
  }

  private prepare(o: Opened): Prog {
    const iface = o.report.interface;
    const buffers = iface ? makeBuffers(iface, ok(o.report.analyses), this.example?.presets) : [];
    const spec: SpecialiseState = { pinned: new Set(), state: new Map() };
    for (const s of this.example?.state ?? []) {
      const res = o.report.state.find((x) => {
        const [k, stage] = Object.entries(x.param)[0];
        return k === s.param && stage === s.stage;
      });
      if (res) spec.state.set(res.resource, [0, 1, 2, 3].map((i) => (s.lanes[i] === undefined ? 0 : res.param && 'texture_dim' in res.param ? s.lanes[i] : floatBits(s.lanes[i]))) as [number, number, number, number]);
    }
    const p: Prog = { ...o, buffers, spec, specialised: null, specError: null };
    // the pipeline state the example sets is in the program the preview draws from the first frame
    this.respecialise(p);
    return p;
  }

  // ---- specialisation ----

  private pins(p: Prog): Pins {
    const words: [number, number, number][] = [];
    for (const b of p.buffers) for (const f of b.fields) if (p.spec.pinned.has(fieldKey(b, f))) words.push(...pinWords(b, f));
    return { words, state: [...p.spec.state] };
  }

  private respecialise(p: Prog): void {
    const pins = this.pins(p);
    if (!pins.words.length && !pins.state.length) {
      p.specialised = null;
      p.specError = null;
    } else {
      const r = JSON.parse(p.shader.specialise(JSON.stringify(pins)));
      if (r && 'Err' in r) {
        p.specialised = null;
        p.specError = r.Err;
      } else {
        p.specialised = r as Specialisations;
        p.specError = null;
      }
    }
  }

  /** The WGSL the preview draws for `p`: the specialised program's on the path shown, else the report's. */
  private drawn(p: Prog): { text: string; note: string | null } | null {
    const base = ok(p.report.wgsl);
    if (!base) return null;
    const s = p.specialised ? (p.report.path === 'ir' ? p.specialised.ir : p.specialised.naga) ?? (p.report.path === 'ir' ? null : p.specialised.naga) : null;
    const spec = s ? ok(s) : undefined;
    const text = spec ? ok(spec.wgsl) : undefined;
    if (text) return { text, note: `drawing the program specialised by ${spec!.by}` };
    return { text: base.text, note: null };
  }

  // ---- rendering ----

  private render(): void {
    const p = this.primary;
    const r = p.report;
    const title = this.example?.title ?? this.progs.map((x) => x.name).join(' + ');
    const facts = (x: Prog) => [x.report.target ?? x.report.format.toUpperCase(), x.report.format.toUpperCase(), plural(x.report.size, 'byte'), x.report.path === 'ir' ? 'IR path' : 'naga path'].filter((v, i, a) => a.indexOf(v) === i);
    const switcher =
      this.progs.length > 1
        ? h(
            'div.switcher',
            { role: 'group', 'aria-label': 'program of the pair' },
            this.progs.map((x, i) =>
              h(
                'button.seg',
                {
                  type: 'button',
                  'aria-pressed': String(i === this.focus),
                  on: {
                    click: () => {
                      this.focus = i;
                      this.render();
                    },
                  },
                },
                `${stageOf(x.report) ?? 'program'} · ${x.name}`,
              ),
            ),
          )
        : null;
    this.el.replaceChildren(
      h(
        'header.ws-head',
        h('div', h('h1', title), this.example ? h('p.summary', this.example.summary) : h('p.summary', 'A dropped file: this view is not shareable by URL.')),
        h('div.facts', this.progs.map((x) => h('span.fact-group', facts(x).map((f) => h('span.fact', f))))),
      ),
      h('div.ws-body', h('section.preview-col', { 'aria-label': 'preview' }, this.previewShell()), h('section.tabs-col', switcher, this.tabList, this.tabBody)),
    );
    if (r.refusal) this.previewMessage.replaceChildren(h('div.error-box', h('strong', 'iridia refused this program. '), r.refusal.message));
    this.renderTabs();
    this.renderSide();
  }

  private previewShell(): HTMLElement {
    const wrap = h('div.preview-wrap');
    if (previewCanvas && preview instanceof Preview) wrap.appendChild(previewCanvas);
    wrap.append(this.previewMessage, this.toast);
    return h('div.preview', wrap, this.toolbar(), this.side);
  }

  private toolbar(): HTMLElement {
    const r = this.primary.report;
    // without WebGPU, or with no program to draw, there is nothing to draw on, orbit or pause
    if (typeof preview === 'string' || r.refusal || !ok(r.wgsl)) return h('div.toolbar', { hidden: true });
    const stage = stageOf(r);
    const canMesh = stage === 'pixel' || stage === 'vertex';
    const items: HTMLElement[] = [];
    if (stage === 'pixel' && this.progs.length === 1) {
      items.push(
        h(
          'div.seg-group',
          { role: 'group', 'aria-label': 'draw on' },
          (['quad', 'mesh'] as const).map((m) =>
            h(
              'button.seg',
              {
                type: 'button',
                'aria-pressed': String((m === 'quad') === this.quad),
                on: {
                  click: () => {
                    this.quad = m === 'quad';
                    this.rebuild();
                  },
                },
              },
              m === 'quad' ? 'Screen quad' : 'Mesh',
            ),
          ),
        ),
      );
    }
    if (canMesh && !this.quad) {
      items.push(
        h(
          'label.inline',
          'Mesh ',
          h(
            'select',
            {
              on: {
                change: (e: Event) => {
                  this.meshName = (e.target as HTMLSelectElement).value as typeof this.meshName;
                  this.rebuild();
                },
              },
            },
            MESHES.map((m) => h('option', { value: m, selected: m === this.meshName }, m === 'knot' ? 'torus knot' : m)),
          ),
        ),
        h(
          'label.inline.toggle',
          h('input', {
            type: 'checkbox',
            checked: this.wireframe,
            on: {
              change: (e: Event) => {
                this.wireframe = (e.target as HTMLInputElement).checked;
                this.rebuild();
              },
            },
          }),
          ' Wireframe',
        ),
      );
    }
    if (stage === 'vertex' && this.progs.length === 1) {
      const outs = ok(r.wgsl)?.outputs.filter((o) => o.location !== null) ?? [];
      items.push(
        h(
          'label.inline',
          'Show ',
          h(
            'select',
            {
              on: {
                change: (e: Event) => {
                  this.shown = Number((e.target as HTMLSelectElement).value);
                  this.rebuild();
                },
              },
            },
            outs.map((o) => h('option', { value: String(o.location), selected: o.location === this.shown }, o.name)),
          ),
        ),
      );
    }
    const outs = (stage === 'pixel' ? ok(this.primary.report.wgsl)?.outputs : [])?.filter((o) => o.location !== null) ?? [];
    if (outs.length > 1)
      items.push(
        h(
          'label.inline',
          'Target ',
          h(
            'select',
            {
              on: {
                change: (e: Event) => {
                  this.target = Number((e.target as HTMLSelectElement).value);
                  this.rebuild();
                },
              },
            },
            outs.map((o) => h('option', { value: String(o.location), selected: o.location === this.target }, o.name)),
          ),
        ),
      );
    items.push(
      h(
        'button.small.ghost',
        {
          type: 'button',
          on: {
            click: (e: Event) => {
              this.paused = !this.paused;
              if (this.paused) this.pausedAt = performance.now();
              else this.start += performance.now() - this.pausedAt;
              (e.target as HTMLElement).textContent = this.paused ? 'Play' : 'Pause';
            },
          },
        },
        'Pause',
      ),
    );
    return h('div.toolbar', items);
  }

  private slots(p: Prog): Slot[] {
    const iface = p.report.interface;
    if (!iface) return [];
    const seen = new Set<number>();
    const out: Slot[] = [];
    for (const r of iface.resources) {
      if (typeof r.kind !== 'object' || !('texture' in r.kind)) continue;
      const reg = r.provenance.d3d?.register ?? null;
      if (reg === null || seen.has(reg)) continue;
      seen.add(reg);
      out.push({ register: reg, name: r.provenance.name, pixels: this.texture(reg, r.provenance.name) });
    }
    return out;
  }

  private texture(register: number, name: string): Pixels {
    let t = this.textures.get(register);
    if (!t) {
      const ex = this.example?.textures?.[register];
      t = placeholder(ex?.kind ?? guess(name));
      this.textures.set(register, t);
    }
    return t;
  }

  private bindTextures(): void {
    for (const p of this.progs)
      for (const s of this.slots(p)) {
        p.shader.setTexture(s.register, s.pixels.width, s.pixels.height, s.pixels.texels, s.pixels.signed);
        if (preview instanceof Preview) preview.setTexture(s.register, s.pixels.width, s.pixels.height, s.pixels.texels, s.pixels.signed);
      }
  }

  private renderSide(): void {
    const changed = () => {
      for (const p of this.progs) if (p.spec.pinned.size) this.respecialise(p);
    };
    const parts: HTMLElement[] = [];
    for (const p of this.progs) {
      const label = this.progs.length > 1 ? ` · ${stageOf(p.report)} program` : '';
      parts.push(h('h3', `Constants${label}`), constantControls(p.buffers, this.sources.map((s) => s.text), changed));
      const slots = this.slots(p);
      if (slots.length)
        parts.push(
          h('h3', `Textures${label}`),
          textureSlots(
            slots,
            async (register, file) => {
              try {
                this.textures.set(register, await fromFile(file));
              } catch (e) {
                this.flash(`That image could not be read: ${e instanceof Error ? e.message : e}`);
                return;
              }
              this.bindTextures();
              this.renderSide();
            },
            (register) => {
              this.textures.delete(register);
              this.bindTextures();
              this.renderSide();
            },
          ),
        );
    }
    const p = this.primary;
    const inputs = ok(p.report.wgsl)?.inputs ?? [];
    if (stageOf(p.report) === 'pixel' && this.progs.length === 1 && inputs.some((i) => i.location !== null)) {
      parts.push(
        h('h3', 'Inputs fed by the page'),
        h(
          'div.controls',
          inputs.map((io, k) =>
            io.location === null
              ? null
              : h(
                  'div.control',
                  h('code', io.name),
                  h(
                    'select',
                    {
                      'aria-label': `what feeds ${io.name}`,
                      on: {
                        change: (e: Event) => {
                          this.feeds[k] = (e.target as HTMLSelectElement).value as Feed;
                          this.rebuild();
                        },
                      },
                    },
                    FEEDS.map((f) => h('option', { value: f, selected: this.feeds[k] === f }, feedName(f))),
                  ),
                ),
          ),
        ),
      );
    }
    this.side.replaceChildren(...parts);
  }

  private renderTabs(): void {
    this.tabList.replaceChildren(
      ...TABS.map((t) =>
        h(
          'button.tab',
          {
            type: 'button',
            role: 'tab',
            id: `tab-${t}`,
            'aria-selected': String(t === this.tab),
            tabIndex: t === this.tab ? 0 : -1,
            on: {
              click: () => this.selectTab(t),
              keydown: (e: KeyboardEvent) => {
                const i = TABS.indexOf(this.tab);
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
                  this.selectTab(next);
                  (this.tabList.querySelector(`#tab-${next}`) as HTMLElement | null)?.focus();
                }
              },
            },
          },
          TAB_NAMES[t],
        ),
      ),
    );
    this.tabBody.setAttribute('aria-labelledby', `tab-${this.tab}`);
    this.tabBody.replaceChildren(this.tabContent());
  }

  private selectTab(t: Tab): void {
    this.tab = t;
    this.renderTabs();
  }

  private tabContent(): HTMLElement {
    const p = this.focused;
    const r = p.report;
    switch (this.tab) {
      case 'source': {
        if (!this.sources.length) return h('p.lede', 'A dropped file comes with no source. The examples ship their HLSL or assembly beside the compiled program.');
        return h(
          'div.sources',
          this.sources.map((s) => h('section', h('h3', s.name), codePane(s.text, s.name.endsWith('.asm') ? 'asm' : 'hlsl', { label: s.name }).el)),
        );
      }
      case 'bytecode':
        return bytecodeView(r, p.bytes, r.refusal?.byte ?? null);
      case 'interface':
        return interfaceView(r);
      case 'lift': {
        const lifted = ok(r.lifted) ?? null;
        const wgsl = ok(r.wgsl)?.text ?? null;
        const view = liftView(r, lifted, wgsl, { lifted: err(r.lifted), wgsl: err(r.wgsl) });
        if (this.progs.length === 2 && p === this.progs[0] && this.linked) {
          const l = ok(this.linked);
          return h(
            'div',
            view,
            h('h3', 'Linked to the pixel program'),
            l ? h('div', l.notes.length ? h('ul.notes', l.notes.map((n) => h('li', n))) : h('p.dim', 'Every output the pixel program reads, at its location and type.'), codePane(l.wgsl.text, 'wgsl', { label: 'linked WGSL' }).el) : h('div.error-box', err(this.linked)),
          );
        }
        return view;
      }
      case 'specialise': {
        this.specView = specialiseView(r, p.buffers, p.spec, () => {
          this.respecialise(p);
          this.specView?.update(p.specialised, p.specError ?? undefined);
          this.rebuild();
        });
        this.respecialise(p);
        this.specView.update(p.specialised, p.specError ?? undefined);
        return this.specView.el;
      }
      case 'flow':
        return flowView(r);
      case 'run':
        return this.runContent();
    }
  }

  private runContent(): HTMLElement {
    const stage = stageOf(this.primary.report);
    const help =
      typeof preview === 'string'
        ? 'Run compares the GPU with iridia’s CPU executors, and this browser has no WebGPU. ' + preview
        : stage === 'vertex' && this.progs.length === 1
          ? 'Click the mesh in the preview: the nearest vertex is drawn alone as a point, its outputs read back, and run by the CPU executors.'
          : stage === 'compute'
            ? 'Click the image in the preview: its texel is read back from the storage texture the GPU wrote.'
            : 'Click a pixel in the preview: what the GPU wrote there is read back exactly, with what the pixel program received, and the CPU executors run on those inputs.';
    const pair = this.progs.length === 2 ? h('p.dim', 'In a pair, a click runs the pixel program on what the linked vertex program fed it.') : null;
    const running = this.running ? `Reading back ${this.running} and running it on the CPU…` : undefined;
    return h('div', pair, runView(this.run, help, this.runError ?? undefined, running));
  }

  // ---- preview ----

  private async startPreview(): Promise<void> {
    const r = this.primary.report;
    if (r.refusal || !ok(r.wgsl)) {
      this.previewMessage.replaceChildren(h('div.error-box', h('strong', 'No preview: '), r.refusal?.message ?? err(r.wgsl) ?? 'no WGSL'));
      return;
    }
    if ((this.example?.view ?? '') === 'none') return;
    this.previewMessage.replaceChildren(h('div.preview-loading', 'Starting WebGPU…'));
    const pv = await getPreview();
    if (!this.alive) return;
    if (typeof pv === 'string') {
      this.previewMessage.replaceChildren(h('div.note-box', pv));
      this.el.querySelector('.toolbar')?.replaceWith(this.toolbar());
      this.renderTabs();
      return;
    }
    this.render();
    pv.onLost = (why) => this.previewMessage.replaceChildren(h('div.error-box', why));
    this.bindTextures();
    this.attachPointer(pv);
    await this.rebuild();
    const loop = () => {
      if (!this.alive) return;
      // a run reads back draws over several frames and gives the executors the constant words: the clock, camera and
      // canvas size hold still until it ends, so every pass and the CPU see the same ones
      if (!this.running) this.frame(pv);
      this.frameId = requestAnimationFrame(loop);
    };
    this.frameId = requestAnimationFrame(loop);
  }

  private program(p: Prog, key: Program['key'], wgsl: Wgsl, text: string): Program {
    const registerOf = new Map<number, number>();
    for (const res of p.report.interface?.resources ?? []) if (res.provenance.d3d) registerOf.set(res.id, res.provenance.d3d.register);
    return {
      key,
      text,
      bindings: wgsl.bindings,
      inputs: wgsl.inputs,
      outputs: wgsl.outputs,
      buffer: (id) => p.buffers.find((b) => b.resource === id)?.words ?? null,
      register: (id) => registerOf.get(id) ?? null,
    };
  }

  private scene(): Scene | string {
    const p = this.primary;
    const stage = stageOf(p.report);
    const wgsl = ok(p.report.wgsl);
    const drawn = this.drawn(p);
    if (!wgsl || !drawn) return err(p.report.wgsl) ?? 'no WGSL';
    const mesh = meshOf(this.quad && stage === 'pixel' && this.progs.length === 1 ? 'screen' : this.meshName);
    const base = { mesh, quad: this.quad && stage === 'pixel' && this.progs.length === 1, wireframe: this.wireframe, target: this.target, shown: this.shown };
    if (stage === 'compute') return { ...base, mode: 'compute', compute: this.program(p, 'compute', wgsl, drawn.text), feeds: [] };
    if (this.progs.length === 2) {
      const l = this.linked ? ok(this.linked) : undefined;
      if (!l) return `The pair does not link: ${this.linked ? err(this.linked) : ''}`;
      const vs = this.progs[0];
      return {
        ...base,
        mode: 'vertex',
        vertex: this.program(vs, 'vertex', l.wgsl, l.wgsl.text),
        pixel: this.program(p, 'pixel', wgsl, drawn.text),
        attributes: (m) => attributes(l.wgsl.inputs, vs.report, m),
        feeds: [],
      };
    }
    if (stage === 'vertex') {
      if (this.shown === null) this.shown = wgsl.outputs.find((o) => o.location !== null)?.location ?? null;
      return { ...base, shown: this.shown, mode: 'vertex', vertex: this.program(p, 'vertex', wgsl, drawn.text), attributes: (m) => attributes(wgsl.inputs, p.report, m), feeds: [] };
    }
    if (stage === 'pixel') {
      const iface = p.report.interface!;
      wgsl.inputs.forEach((io, k) => {
        if (this.feeds[k]) return;
        const label = iface.inputs[io.varying]?.label;
        this.feeds[k] = label ? defaultFeed(label.name, label.index) : 'uv';
      });
      return { ...base, mode: 'pixel', pixel: this.program(p, 'pixel', wgsl, drawn.text), feeds: this.feeds };
    }
    return `the preview draws vertex, pixel and compute programs; this is a ${stage} program`;
  }

  private async rebuild(): Promise<void> {
    const pv = preview;
    if (!(pv instanceof Preview)) return;
    const scene = this.scene();
    this.el.querySelector('.toolbar')?.replaceWith(this.toolbar());
    if (typeof scene === 'string') {
      this.previewMessage.replaceChildren(h('div.error-box', h('strong', 'No preview: '), scene));
      return;
    }
    try {
      await pv.show(scene);
      const note = this.drawn(this.primary)?.note;
      this.previewMessage.replaceChildren(note ? h('div.preview-note', note) : '');
    } catch (e) {
      this.previewMessage.replaceChildren(h('div.error-box', h('strong', 'WebGPU refused the program: '), e instanceof Error ? e.message : String(e)));
    }
  }

  private camera(aspect: number): { camera: Camera; view: Float32Array; projection: Float32Array; world: Float32Array } {
    const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const view = this.orbit.view();
    const projection = this.orbit.projection(aspect);
    return { camera: { world, viewProjection: multiply(projection, view), normal: world }, view, projection, world };
  }

  private frame(pv: Preview): void {
    const canvas = pv.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    const { camera, view, projection, world } = this.camera(w / hgt);
    const seconds = ((this.paused ? this.pausedAt : performance.now()) - this.start) / 1000;
    const tex0 = this.textures.get(0);
    for (const p of this.progs)
      for (const b of p.buffers)
        for (const f of b.fields) {
          const role = f.role;
          if (!role) continue;
          switch (role.kind) {
            case 'time':
              setLanes(b, f, [seconds]);
              break;
            case 'mouse':
              setLanes(b, f, [this.mouse[0], this.mouse[1], 0, 0]);
              break;
            case 'resolution':
              setLanes(b, f, [w, hgt, 1 / w, 1 / hgt]);
              break;
            case 'texel-size':
              if (tex0) setLanes(b, f, [1 / tex0.width, 1 / tex0.height]);
              break;
            case 'eye':
              setLanes(b, f, this.orbit.eye());
              break;
            case 'matrix': {
              const m =
                role.which === 'world'
                  ? world
                  : role.which === 'view'
                    ? view
                    : role.which === 'projection'
                      ? projection
                      : role.which === 'view-projection'
                        ? multiply(projection, view)
                        : role.which === 'world-view'
                          ? multiply(view, world)
                          : multiply(multiply(projection, view), world);
              setMatrix(b, f, m);
              break;
            }
          }
        }
    pv.frame(camera);
  }

  private attachPointer(pv: Preview): void {
    const canvas = pv.canvas;
    const hasMouse = () => this.progs.some((p) => p.buffers.some((b) => b.fields.some((f) => f.role?.kind === 'mouse')));
    canvas.onpointerdown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.dragging = { x: e.clientX, y: e.clientY, moved: false };
    };
    canvas.onpointermove = (e) => {
      const rect = canvas.getBoundingClientRect();
      if (!this.dragging) return;
      const dx = e.clientX - this.dragging.x;
      const dy = e.clientY - this.dragging.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.dragging.moved = true;
      if (!this.dragging.moved) return;
      if (hasMouse() && (this.quad || stageOf(this.primary.report) === 'compute')) {
        this.mouse = [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
      } else {
        this.orbit.drag(dx, dy);
      }
      this.dragging.x = e.clientX;
      this.dragging.y = e.clientY;
    };
    canvas.onpointerup = (e) => {
      const d = this.dragging;
      this.dragging = null;
      if (d && !d.moved) {
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width);
        const y = Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height);
        void this.runAt(pv, x, y);
      }
    };
    canvas.onwheel = (e) => {
      if (this.quad) return;
      e.preventDefault();
      this.orbit.zoom(e.deltaY);
    };
    canvas.tabIndex = 0;
    canvas.onkeydown = (e) => {
      const step = 12;
      if (e.key === 'ArrowLeft') this.orbit.drag(-step, 0);
      else if (e.key === 'ArrowRight') this.orbit.drag(step, 0);
      else if (e.key === 'ArrowUp') this.orbit.drag(0, -step);
      else if (e.key === 'ArrowDown') this.orbit.drag(0, step);
      else if (e.key === '+' || e.key === '=') this.orbit.zoom(-200);
      else if (e.key === '-') this.orbit.zoom(200);
      else if (e.key === 'Enter') void this.runAt(pv, canvas.width >> 1, canvas.height >> 1);
      else return;
      e.preventDefault();
    };
  }

  private flash(text: string, cls = ''): void {
    this.toast.className = `toast show ${cls}`;
    this.toast.textContent = text;
    clearTimeout((this.toast as any)._t);
    (this.toast as any)._t = setTimeout(() => (this.toast.className = 'toast'), 4000);
  }

  private request(p: Prog, lanes: [number, number, number, number][][]): Request {
    return {
      lanes: lanes.map((inputs) => ({ inputs })),
      buffers: requestBuffers(p.buffers),
      state: p.report.state.map((s) => [s.resource, p.spec.state.get(s.resource) ?? s.default] as [number, [number, number, number, number]]),
    };
  }

  private async runAt(pv: Preview, x: number, y: number): Promise<void> {
    if (this.running) return;
    const stage = stageOf(this.primary.report);
    this.running = stage === 'compute' ? `texel (${x}, ${y})` : stage === 'vertex' && this.progs.length === 1 ? 'the vertex nearest the click' : `pixel (${x}, ${y})`;
    this.runError = null;
    if (this.tab === 'run') this.renderTabs();
    else this.flash(`Reading back ${this.running}…`);
    try {
      if (stage === 'compute') await this.runCompute(pv, x, y);
      else if (stage === 'vertex' && this.progs.length === 1) await this.runVertex(pv, x, y);
      else await this.runPixel(pv, x, y);
      const v = this.tab === 'run' ? null : this.run;
      if (v) {
        const exec = v.executed.map((e) => ok(e.lanes)?.[v.lane]);
        let all = 0;
        let same = 0;
        v.iface.outputs.forEach((o, i) => {
          for (let l = 0; l < o.value.width; l++)
            for (const e of exec) {
              const c = e?.outputs[i]?.[l];
              if (c === undefined) continue;
              all++;
              if (v.gpu[i]?.[l] === c) same++;
            }
        });
        if (v.kind !== 'compute' && !v.covered) this.flash('No fragment there.');
        else this.flash(all && same === all ? 'A = B = C at this pixel: see Run' : `${same} of ${all} CPU lanes match the GPU: see Run`, all && same === all ? 'good' : 'warn');
      }
    } catch (e) {
      this.runError = `The run failed: ${e instanceof Error ? e.message : String(e)}`;
      this.flash(this.runError, 'warn');
    } finally {
      this.running = null;
      if (this.tab === 'run') this.renderTabs();
    }
  }

  private execute(p: Prog, req: Request): Executed[] {
    const r = JSON.parse(p.shader.execute(JSON.stringify(req)));
    if ('Err' in r) throw new Error(r.Err);
    return r.Ok as Executed[];
  }

  private async runPixel(pv: Preview, x: number, y: number): Promise<void> {
    const p = this.primary;
    const iface = p.report.interface!;
    const wgsl = ok(p.report.wgsl)!;
    const cap = await pv.capturePixel(x, y);
    const lane = (y - cap.origin[1]) * 2 + (x - cap.origin[0]);
    const zero: [number, number, number, number] = [0, 0, 0, 0];
    const lanes = [0, 1, 2, 3].map((l) => {
      const inputs = iface.inputs.map(() => zero);
      wgsl.inputs.forEach((io, k) => {
        if (io.varying >= 0 && io.varying < inputs.length) inputs[io.varying] = cap.inputs[l][k] ?? zero;
      });
      return inputs;
    });
    const quad = p.report.needs_quad;
    const executed = this.execute(p, this.request(p, quad ? lanes : [lanes[Math.min(3, Math.max(0, lane))]]));
    const gpu = iface.outputs.map((_, o) => {
      const io = wgsl.outputs.find((w) => w.varying === o && w.location !== null);
      return io ? (cap.outputs[lane][io.location!] ?? null) : null;
    });
    this.run = {
      kind: 'pixel',
      where: `Pixel (${x}, ${y})${quad ? `, lane ${lane} of the 2 × 2 quad at (${cap.origin[0]}, ${cap.origin[1]}): the program takes derivatives, so the executors run the whole quad` : ''}.`,
      lane: quad ? lane : 0,
      iface,
      inputs: lanes[lane],
      gpu,
      executed,
      covered: cap.covered[lane],
      gpuNote: this.drawn(p)?.note ? 'The GPU draws the specialised program; the executors run the lifted program with the same constant words and state.' : undefined,
    };
  }

  private async runVertex(pv: Preview, x: number, y: number): Promise<void> {
    const p = this.primary;
    const iface = p.report.interface!;
    const wgsl = ok(p.report.wgsl)!;
    const m = meshOf(this.meshName);
    // the vertex nearest the click by the page's camera (the program's own transform decides where it lands)
    const { camera } = this.camera(pv.canvas.width / pv.canvas.height);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < m.count; i++) {
      const c = transformPoint(camera.viewProjection, [m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2]]);
      if (c[3] <= 0) continue;
      const sx = ((c[0] / c[3]) * 0.5 + 0.5) * pv.canvas.width;
      const sy = (0.5 - (c[1] / c[3]) * 0.5) * pv.canvas.height;
      const d = (sx - x) ** 2 + (sy - y) ** 2 + (c[2] / c[3]) * 10;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const attrs = attributes(wgsl.inputs, p.report, m);
    const zero: [number, number, number, number] = [0, 0, 0, 0];
    const inputs = iface.inputs.map(() => zero);
    wgsl.inputs.forEach((io, k) => {
      const a = attrs[k];
      if (a && io.varying >= 0) inputs[io.varying] = Array.from(new Uint32Array(a.data, best * 16, 4)) as [number, number, number, number];
    });
    const cap = await pv.captureVertex(best);
    const executed = this.execute(p, this.request(p, [inputs]));
    const gpu = iface.outputs.map((_, o) => {
      const io = wgsl.outputs.find((w) => w.varying === o);
      return io && io.location !== null ? (cap.outputs[io.location] ?? null) : null;
    });
    this.run = {
      kind: 'vertex',
      where: `Vertex ${best} of the ${m.name}: drawn alone as a point${cap.at ? ', read back where it landed' : ', which lands outside the view: the GPU column is empty'}. The clip position is the rasteriser’s, not read back.`,
      lane: 0,
      iface,
      inputs,
      gpu,
      executed,
      covered: !!cap.at,
    };
  }

  private async runCompute(pv: Preview, x: number, y: number): Promise<void> {
    const p = this.primary;
    const iface = p.report.interface!;
    const t = await pv.captureTexel(x, y);
    if (!t) throw new Error('that is outside the image');
    const inputs = iface.inputs.map((v): [number, number, number, number] => (/dispatchthreadid/i.test(v.label.name) ? [t.texel[0], t.texel[1], 0, 0] : [0, 0, 0, 0]));
    const executed = this.execute(p, this.request(p, [inputs]));
    this.run = {
      kind: 'compute',
      where: `Thread (${t.texel[0]}, ${t.texel[1]}, 0): the texel it wrote, read back from the storage texture: ${t.words.map((w) => new Float32Array(new Uint32Array([w]).buffer)[0].toFixed(4)).join(', ')}.`,
      lane: 0,
      iface,
      inputs,
      gpu: [],
      executed,
      covered: true,
    };
  }
}

function feedName(f: Feed): string {
  return { uv: 'texture coordinate', world: 'world position', normal: 'normal', tangent: 'tangent', color: 'vertex colour', screen: 'screen position', clip: 'clip position', zero: 'zero' }[f];
}

/** A vertex program's inputs from the mesh, by semantic: four lanes a vertex, each in its own buffer. */
export function attributes(inputs: Io[], report: Report, m: Mesh): { data: ArrayBuffer; format: GPUVertexFormat; location: number }[] {
  const iface = report.interface;
  return inputs
    .filter((io) => io.location !== null)
    .map((io) => {
      const label = iface?.inputs[io.varying]?.label.name.toUpperCase() ?? '';
      const data = new Float32Array(m.count * 4);
      for (let i = 0; i < m.count; i++) {
        let v: number[];
        if (label === 'POSITION') v = [m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2], 1];
        else if (label === 'NORMAL') v = [m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2], 0];
        else if (label === 'TANGENT') v = Array.from(m.tangent.slice(i * 4, i * 4 + 4));
        else if (label === 'COLOR') v = Array.from(m.color.slice(i * 4, i * 4 + 4));
        else if (label === 'TEXCOORD') v = [m.uv[i * 2], m.uv[i * 2 + 1], 0, 1];
        else v = [0, 0, 0, 0];
        data.set(v, i * 4);
      }
      const integer = io.scalar === 'uint' || io.scalar === 'sint';
      const buffer = integer ? new Uint32Array(data.length) : data;
      return { data: buffer.buffer, format: (integer ? (io.scalar === 'uint' ? 'uint32x4' : 'sint32x4') : 'float32x4') as GPUVertexFormat, location: io.location! };
    });
}

/** Fetch an example's programs and sources. */
export async function fetchExample(ex: Example): Promise<{ files: { name: string; bytes: Uint8Array }[]; sources: { name: string; text: string }[] }> {
  const get = async (path: string) => {
    const r = await fetch(exampleUrl(path));
    if (!r.ok) throw new Error(`${path}: ${r.status} ${r.statusText}`);
    return r;
  };
  const programs = [ex.program, ...(ex.pixel ? [ex.pixel] : [])];
  const files = await Promise.all(programs.map(async (p) => ({ name: p.split('/').pop()!, bytes: new Uint8Array(await (await get(p)).arrayBuffer()) })));
  const sources = await Promise.all(ex.sources.map(async (s) => ({ name: s.name, text: await (await get(s.path)).text() })));
  return { files, sources };
}


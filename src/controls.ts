// The controls the constant buffers' reflection gives: a slider, toggle, colour or lanes per field, a badge for what
// the page drives itself; and the texture slots, each with its placeholder or a dropped image.
import { type Buffer, type Field, getLanes, setLanes } from './constants';
import { h, plural } from './dom';
import type { Pixels } from './gpu/textures';

const COLOUR = /colou?r|tint|albedo|sky|ground|ink|rim/i;

/** A range from the source's comment (`float speed; // 0.2 .. 3`), where the page has the source. */
export function sourceRanges(sources: string[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const s of sources)
    for (const m of s.matchAll(/(\w+)\s*(?:=[^;]*)?;\s*\/\/\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)/g)) out.set(m[1], [Number(m[2]), Number(m[3])]);
  return out;
}

const roleText = (f: Field): string | null => {
  const r = f.role;
  if (!r) return null;
  switch (r.kind) {
    case 'time':
      return 'seconds since the page drew it';
    case 'mouse':
      return 'the pointer over the preview, 0 to 1';
    case 'resolution':
      return 'the preview’s size in pixels';
    case 'texel-size':
      return '1 / the size of texture 0';
    case 'eye':
      return 'the orbit camera’s position';
    case 'matrix':
      return `the camera’s ${r.which.replace(/-/g, ' ')} matrix, ${r.lines === 'rows' ? 'its rows in the lines' : r.lines === 'columns' ? 'its columns in the lines' : 'lines unshown by the program: written as rows'}`;
  }
};

/** A field's name with a line-break opportunity at each word boundary (`world<wbr>View<wbr>Projection`, `ps_<wbr>bias`). */
function nameOf(name: string): HTMLElement {
  const words = name.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=_)/);
  return h('code', words.flatMap((w, i) => (i ? [h('wbr'), w] : [w])));
}

function fieldControl(b: Buffer, f: Field, ranges: Map<string, [number, number]>, changed: () => void): HTMLElement {
  const id = `f-${b.resource}-${f.offset}`;
  const label = h('label', { htmlFor: id }, nameOf(f.name));
  const auto = roleText(f);
  if (auto) return h('div.control.auto', label, h('span.badge', 'auto'), h('span.dim.small', auto));
  if (f.matrix) return h('div.control', label, h('span.dim.small', 'a matrix the page does not drive'));
  const values = getLanes(b, f);
  const set = (v: number[]) => {
    setLanes(b, f, v);
    changed();
  };
  if ((f.scalar === 'uint' || f.scalar === 'bool' || f.scalar === 'sint') && f.width === 1 && (/^(use|enable|has|is)[A-Z_]/.test(f.name) || f.scalar === 'bool')) {
    const box = h('input', { id, type: 'checkbox', checked: values[0] !== 0, on: { change: () => set([box.checked ? 1 : 0]) } });
    return h('div.control', h('label.toggle', box, nameOf(f.name)));
  }
  if (f.scalar === 'float' && f.width >= 3 && COLOUR.test(f.name)) {
    const toHex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    const input = h('input', {
      id,
      type: 'color',
      value: `#${values.slice(0, 3).map(toHex).join('')}`,
      on: {
        input: () => {
          const c = input.value;
          const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
          set(f.width === 4 ? [...rgb, values[3] ?? 1] : rgb);
        },
      },
    });
    return h('div.control', label, input);
  }
  if (f.width === 1) {
    const isInt = f.scalar !== 'float';
    const v = values[0];
    const [lo, hi] = ranges.get(f.name) ?? (isInt ? [0, Math.max(16, v * 2)] : v < 0 ? [v * 2, -v * 2] : [0, Math.max(1, v * 2)]);
    const step = isInt ? 1 : (hi - lo) / 500;
    const out = h('output.mono', { htmlFor: id }, fmt(v, isInt));
    const range = h('input', {
      id,
      type: 'range',
      min: String(lo),
      max: String(hi),
      step: String(step),
      value: String(v),
      on: {
        input: () => {
          const x = Number(range.value);
          out.textContent = fmt(x, isInt);
          set([x]);
        },
      },
    });
    return h('div.control', label, range, out);
  }
  const inputs = values.map((v, i) =>
    h('input.num', {
      type: 'number',
      step: f.scalar === 'float' ? '0.05' : '1',
      value: fmt(v, f.scalar !== 'float'),
      'aria-label': `${f.name} lane ${'xyzw'[i]}`,
      on: {
        input: (e: Event) => {
          const next = getLanes(b, f);
          next[i] = Number((e.target as HTMLInputElement).value);
          set(next);
        },
      },
    }),
  );
  return h('div.control', label, h('span.lanes', inputs));
}

const fmt = (v: number, isInt: boolean): string => (isInt ? String(Math.round(v)) : String(Math.round(v * 1000) / 1000));

export function constantControls(buffers: Buffer[], sources: string[], changed: () => void): HTMLElement {
  const ranges = sourceRanges(sources);
  if (!buffers.length) return h('p.dim', 'No constant buffer.');
  return h(
    'div.controls',
    buffers.map((b) =>
      h(
        'fieldset',
        h('legend', b.name, h('span.dim', ` · ${plural(b.fields.length, 'field')}`)),
        b.fields.length ? b.fields.map((f) => fieldControl(b, f, ranges, changed)) : h('p.dim.small', 'The program states no names: its words are bound as zeros.'),
      ),
    ),
  );
}

export interface Slot {
  register: number;
  name: string;
  pixels: Pixels;
}

function thumbnail(p: Pixels): HTMLCanvasElement {
  const c = h('canvas.thumb', { width: 48, height: 48 });
  const ctx = c.getContext('2d');
  if (ctx) {
    const src = new ImageData(p.width, p.height);
    for (let i = 0; i < p.texels.length; i++) src.data[i] = p.signed ? ((p.texels[i] << 24) >> 24) + 128 : p.texels[i];
    const tmp = new OffscreenCanvas(p.width, p.height);
    tmp.getContext('2d')?.putImageData(src, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, 48, 48);
  }
  return c;
}

export function textureSlots(slots: Slot[], onFile: (register: number, file: File) => void, onReset: (register: number) => void): HTMLElement {
  if (!slots.length) return h('p.dim', 'No texture.');
  return h(
    'div.slots',
    slots.map((s) => {
      const file = h('input.visually-hidden', {
        type: 'file',
        accept: 'image/*',
        id: `slot-${s.register}`,
        on: { change: () => file.files?.[0] && onFile(s.register, file.files[0]) },
      });
      const slot = h(
        'div.slot',
        thumbnail(s.pixels),
        h('div', h('code', `t${s.register}`), ' ', h('span', s.name), h('div.dim.small', s.pixels.label + (s.pixels.signed ? ' · rgba8snorm' : ''))),
        h('label.button.small', { htmlFor: `slot-${s.register}` }, 'Image…'),
        file,
        h('button.small.ghost', { type: 'button', on: { click: () => onReset(s.register) } }, 'Reset'),
      );
      slot.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        slot.classList.add('over');
      });
      slot.addEventListener('dragleave', () => slot.classList.remove('over'));
      slot.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        slot.classList.remove('over');
        const f = e.dataTransfer?.files[0];
        if (f) onFile(s.register, f);
      });
      return slot;
    }),
  );
}

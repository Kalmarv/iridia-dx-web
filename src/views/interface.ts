// The interface iridia states: the varyings in and out (with the D3D register and lanes each came from, and the WGSL
// location it takes), each resource and its binding, constant buffer layouts with what the program reads of them, and
// the lines of each matrix as the program applies it.
import { h, hex } from '../dom';
import type { Analyses, ConstantType, MatrixLines, Report, Varying, Wgsl } from '../types';
import { ok } from '../types';

const lanes = (mask: number) => ['x', 'y', 'z', 'w'].filter((_, i) => mask & (1 << i)).join('');

export function typeName(ty: ConstantType): string {
  if ('scalar' in ty) return ty.scalar;
  if ('vector' in ty) return `${ty.vector.scalar}${ty.vector.width}`;
  if ('matrix' in ty) return `${ty.matrix.scalar}${ty.matrix.rows}x${ty.matrix.columns} (${ty.matrix.major}-major lines, stride ${ty.matrix.stride})`;
  if ('array' in ty) return `${typeName(ty.array.element)}[${ty.array.count}] (stride ${ty.array.stride})`;
  return `struct { ${ty.struct.members.map((m) => `${m.name}: ${typeName(m.ty)}`).join(', ')} }`;
}

export function linesText(lines: MatrixLines): string {
  if (lines === 'rows') return 'each line is a row of the matrix applied to column vectors';
  if (lines === 'columns') return 'each line is a column of the matrix applied to column vectors';
  const why = (lines as { unshown: unknown }).unshown;
  return `the program does not show which (${typeof why === 'string' ? why.replace(/_/g, ' ') : JSON.stringify(why)})`;
}

function system(v: Varying): string {
  if (!v.system) return '';
  if (typeof v.system === 'string') return v.system.replace(/_/g, ' ');
  return Object.entries(v.system)
    .map(([k, x]) => `${k.replace(/_/g, ' ')} ${x}`)
    .join(', ');
}

function varyings(title: string, list: Varying[], wgsl: Wgsl | undefined, side: 'inputs' | 'outputs'): HTMLElement {
  const ios = wgsl?.[side] ?? [];
  return h(
    'section',
    h('h3', title),
    list.length
      ? h(
          'table.data',
          h('thead', h('tr', ['Semantic', 'System value', 'Type', 'D3D register', 'WGSL', 'Interpolation', 'Used'].map((t) => h('th', t)))),
          h(
            'tbody',
            list.map((v, i) => {
              const io = ios.find((x) => x.varying === i);
              const d3d = v.provenance.d3d;
              return h(
                'tr',
                { class: v.used ? '' : 'dim' },
                h('td.mono', `${v.label.name}${v.label.index}`),
                h('td', system(v)),
                h('td.mono', `${v.value.scalar}${v.value.width > 1 ? v.value.width : ''}`),
                h('td.mono', d3d ? `${d3d.register}.${lanes(d3d.mask)}` : ''),
                h('td.mono', io ? (io.builtin ? `@builtin(${io.builtin})` : `@location(${io.location})`) : '—'),
                h('td', io?.interpolation ?? v.interp ?? ''),
                h('td', v.used ? 'yes' : 'no'),
              );
            }),
          ),
        )
      : h('p.dim', 'None.'),
  );
}

export function interfaceView(report: Report): HTMLElement {
  const iface = report.interface;
  if (!iface) return h('div.error-box', h('strong', 'No interface: '), report.refusal?.message ?? 'the program did not lift.');
  const wgsl = ok(report.wgsl);
  const analyses: Analyses | undefined = ok(report.analyses);
  const binding = (id: number) => wgsl?.bindings.find((b) => b.resource === id);
  const resources = iface.resources.map((r) => {
    const b = binding(r.id);
    const d3d = r.provenance.d3d;
    const where = h('span.mono.where', [d3d ? `${d3d.class.replace(/_/g, ' ')} ${d3d.register}${d3d.space ? ` space${d3d.space}` : ''}` : '', b ? ` → @group(${b.group}) @binding(${b.binding})` : ''].join(''));
    const kind = r.kind;
    if (typeof kind === 'object' && 'constant_buffer' in kind) {
      const read = analyses?.constants_read.find(([id]) => id === r.id)?.[1] ?? null;
      const layout = kind.constant_buffer.layout;
      return h(
        'section.resource',
        h('h4', h('span.kind', 'constant buffer'), ` ${r.provenance.name} `, where, h('span.dim', ` · ${layout.size} bytes`)),
        h(
          'table.data',
          h('thead', h('tr', ['Offset', 'Name', 'Type', 'Default', 'Read by the program', 'Lines'].map((t) => h('th', t)))),
          h(
            'tbody',
            layout.constants.map((c) => {
              const m = analyses?.matrices.find((x) => x.resource === r.id && x.offset === c.offset);
              const isRead = read ? read.some((o) => o >= c.offset && o < c.offset + sizeHint(c.ty)) : null;
              return h(
                'tr',
                { class: isRead === false ? 'dim' : '' },
                h('td.mono', hex(c.offset, 4)),
                h('td.mono', c.name),
                h('td.mono', typeName(c.ty)),
                h('td.mono', c.default ? defaultText(c.default, c.ty) : ''),
                h('td', isRead === null ? '—' : isRead ? 'yes' : 'no'),
                h('td', m ? linesText(m.lines) : ''),
              );
            }),
          ),
        ),
      );
    }
    if (typeof kind === 'object' && 'pipeline_state' in kind) {
      const [name, stage] = Object.entries(kind.pipeline_state)[0];
      return h('section.resource', h('h4', h('span.kind', 'pipeline state'), ` ${name.replace(/_/g, ' ')} of stage ${stage} `, h('span.dim', '· set with the draw; specialisation folds it')));
    }
    const label = typeof kind === 'string' ? kind.replace(/_/g, ' ') : Object.keys(kind)[0].replace(/_/g, ' ');
    const detail = typeof kind === 'object' ? JSON.stringify(Object.values(kind)[0]).replace(/[{}"]/g, '').replace(/,/g, ', ').replace(/:/g, ': ') : '';
    return h('section.resource', h('h4', h('span.kind', label), ` ${r.provenance.name} `, where), detail && h('p.dim.mono', detail));
  });
  return h(
    'div.interface',
    h('p.lede', `${iface.stage} program · ${report.target ?? ''} · lifted by ${report.lifter ?? '—'} on the ${report.path === 'ir' ? 'IR path' : 'naga path'}`),
    varyings('Inputs', iface.inputs, wgsl, 'inputs'),
    varyings('Outputs', iface.outputs, wgsl, 'outputs'),
    h('section', h('h3', 'Resources'), resources.length ? resources : h('p.dim', 'None.')),
    report.notes.length ? h('section', h('h3', 'What the lifter noted'), h('ul.notes', report.notes.map((n) => h('li', n)))) : null,
  );
}

function sizeHint(ty: ConstantType): number {
  if ('scalar' in ty) return 4;
  if ('vector' in ty) return ty.vector.width * 4;
  if ('matrix' in ty) {
    const m = ty.matrix;
    const lines = m.major === 'row' ? m.rows : m.columns;
    const lanes = m.major === 'row' ? m.columns : m.rows;
    return (lines - 1) * m.stride + lanes * 4;
  }
  if ('array' in ty) return (ty.array.count - 1) * ty.array.stride + sizeHint(ty.array.element);
  return Math.max(4, ...ty.struct.members.map((m) => m.offset + sizeHint(m.ty)));
}

function defaultText(bytes: number[], ty: ConstantType): string {
  const view = new DataView(new Uint8Array(bytes).buffer);
  const scalar = 'scalar' in ty ? ty.scalar : 'vector' in ty ? ty.vector.scalar : 'matrix' in ty ? ty.matrix.scalar : 'float';
  const out: string[] = [];
  for (let i = 0; i + 4 <= bytes.length && out.length < 16; i += 4) {
    out.push(scalar === 'float' ? String(Math.round(view.getFloat32(i, true) * 1e4) / 1e4) : scalar === 'sint' ? String(view.getInt32(i, true)) : String(view.getUint32(i, true)));
  }
  return out.join(', ');
}


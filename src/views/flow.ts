// The analyses iridia runs on a lifted program: what each output lane is made of (inputs, constants, texels, and
// whether as its value, an address or a decision), what decides a discard, which constant words the program reads.
import { h, hex } from '../dom';
import type { Analyses, Interface, Report, Source } from '../types';
import { err, ok } from '../types';
import { linesText } from './interface';

const LANES = 'xyzw';

function sourceName(s: Source, iface: Interface): string {
  if (s.kind === 'input') {
    const v = iface.inputs[s.index];
    return v ? `${v.label.name}${v.label.index}.${LANES[s.at] ?? s.at}` : `input ${s.index}.${s.at}`;
  }
  const r = iface.resources.find((x) => x.id === s.index);
  if (s.kind === 'constant') {
    const k = r && typeof r.kind === 'object' && 'constant_buffer' in r.kind ? r.kind.constant_buffer.layout.constants : [];
    const c = [...k].reverse().find((c) => c.offset <= s.at);
    return c ? `${c.name}${s.at > c.offset ? `+${s.at - c.offset}` : ''}` : `${r?.provenance.name ?? 'cb'}@${hex(s.at, 4)}`;
  }
  return `${r?.provenance.name ?? `texture ${s.index}`}${s.at ? `.${LANES[s.at] ?? s.at}` : ''}`;
}

function chips(sources: Source[], iface: Interface): HTMLElement {
  return h(
    'span.chips',
    sources.map((s) => h(`span.chip.${s.kind}.via-${s.via}`, { title: `${s.kind}, reaching it as ${s.via}` }, sourceName(s, iface))),
  );
}

export function flowView(report: Report): HTMLElement {
  const iface = report.interface;
  if (!iface) return h('div.error-box', report.refusal?.message ?? 'No program.');
  const a: Analyses | undefined = ok(report.analyses);
  if (!a)
    return h(
      'div.flow',
      h('div.error-box', h('strong', 'No analyses for this program: '), err(report.analyses) ?? ''),
      h('p.note', 'The analyses read naga-path programs: DXBC, DXIL, and Direct3D 9 vs_3_0 and ps_3_0.'),
    );
  const reach = ok(a.reach);
  const byOutput = new Map<number, typeof reach>();
  for (const r of reach ?? []) {
    const list = byOutput.get(r.output) ?? [];
    list.push(r);
    byOutput.set(r.output, list);
  }
  return h(
    'div.flow',
    h('p.lede', 'Lane provenance: what reaches each output lane, read from the lifted program’s value graph. A source reaches as a value, as a coordinate (it picks the texel sampled), or as a decision (a branch or select).'),
    h('div.legend', h('span.chip.input', 'input'), h('span.chip.constant', 'constant'), h('span.chip.texel', 'texel'), h('span.chip.via-coordinate.input', 'as a coordinate'), h('span.chip.via-control.input', 'as a decision')),
    reach
      ? h(
          'table.data.flow-table',
          h('thead', h('tr', h('th', 'Output lane'), h('th', 'Made of'))),
          h(
            'tbody',
            [...byOutput].flatMap(([o, lanes]) =>
              (lanes ?? []).map((r) => {
                const v = iface.outputs[o];
                return h('tr', h('td.mono', `${v ? `${v.label.name}${v.label.index}` : `output ${o}`}.${LANES[r.lane]}`), h('td', r.sources.length ? chips(r.sources, iface) : h('span.dim', 'constants of the code alone')));
              }),
            ),
          ),
        )
      : h('div.error-box', 'Lane provenance: ', err(a.reach) ?? ''),
    h('section', h('h3', 'What decides a discard'), a.discard.length ? chips(a.discard, iface) : h('p.dim', 'The program does not discard.')),
    h(
      'section',
      h('h3', 'Matrix lines'),
      a.matrices.length
        ? h('ul.notes', a.matrices.map((m) => h('li', h('code', m.name), `: ${linesText(m.lines)}. The preview writes its camera matrices by this.`)))
        : h('p.dim', 'No matrix constants.'),
    ),
    h(
      'section',
      h('h3', 'Constant words read'),
      a.constants_read.length
        ? h(
            'ul.notes',
            a.constants_read.map(([id, offsets]) => {
              const r = iface.resources.find((x) => x.id === id);
              return h('li', h('code', r?.provenance.name ?? `resource ${id}`), `: ${offsets.length} word${offsets.length === 1 ? '' : 's'} at ${offsets.map((o) => hex(o, 4)).join(', ')}`);
            }),
          )
        : h('p.dim', 'The program reads no constant buffer.'),
    ),
  );
}

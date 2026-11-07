// The lift: iridia's program text beside its WGSL. On the IR path each value's line carries where its source
// instruction starts (a token stream's word, a DXIL record's bit), so a line leads to its listed instruction and to
// every other line of that instruction; where the WGSL names values after the IR (`let v12`), its lines are tied to the
// IR's too.
import { bitPlace, h } from '../dom';

import type { Lifted, Report } from '../types';
import { codePane } from './code';

/** `%N` defined on each line of an IR text. */
function definitions(text: string): Map<number, number> {
  const out = new Map<number, number>();
  text.split('\n').forEach((l, i) => {
    const m = l.match(/^\s*%(\d+):/);
    if (m) out.set(Number(m[1]), i);
  });
  return out;
}

/** `let vN` (and `vN =`) lines of a WGSL text, by N. */
function wgslNames(text: string): Map<number, number> {
  const out = new Map<number, number>();
  text.split('\n').forEach((l, i) => {
    const m = l.match(/^\s*(?:let|var)\s+v(\d+)\b/);
    if (m && !out.has(Number(m[1]))) out.set(Number(m[1]), i);
  });
  return out;
}

export function liftView(report: Report, lifted: Lifted | null, wgsl: string | null, why: { lifted?: string; wgsl?: string }, title = 'Lifted'): HTMLElement {
  const bc = report.bytecode;
  const listing = 'Ok' in bc.listing ? bc.listing.Ok.split('\n') : [];
  const origin = new Map(lifted?.origins ?? []);
  const instructionOf = (bit: number) => bc.instructions.find((i) => bit >= i.bits[0] && bit < i.bits[1]);
  const tied = lifted?.kind === 'ir' && origin.size > 0;
  // dx lists a container's debug module where it has one, stored apart from the DXIL part iridia lifts
  const apart = bc.listed_part === 'ILDB';
  const strip = h(
    'div.origin-strip',
    tied
      ? `Click a line of the IR: its source instruction shows here, and every line it became is marked.${apart ? ' The listing is of the ILDB debug module, stored apart from the DXIL part iridia lifts, so a line shows where its record is but not its listed text.' : ''}`
      : '',
  );
  const defs = lifted ? definitions(lifted.text) : new Map<number, number>();
  const names = wgsl ? wgslNames(wgsl) : new Map<number, number>();
  const valueOfLine = new Map([...defs].map(([v, l]) => [l, v]));
  const wgslLineValue = new Map([...names].map(([v, l]) => [l, v]));

  let irPane: ReturnType<typeof codePane> | null = null;
  let wgslPane: ReturnType<typeof codePane> | null = null;
  const select = (irLine: number | null, wgslLine: number | null) => {
    const value = irLine !== null ? valueOfLine.get(irLine) : wgslLine !== null ? wgslLineValue.get(wgslLine) : undefined;
    if (irLine === null && value !== undefined) irLine = defs.get(value) ?? null;
    const bit = irLine !== null ? origin.get(irLine) : undefined;
    const ins = bit !== undefined && !apart ? instructionOf(bit) : undefined;
    const same = bit !== undefined ? [...origin].filter(([, b]) => (ins ? b >= ins.bits[0] && b < ins.bits[1] : b === bit)).map(([l]) => l) : irLine !== null ? [irLine] : [];
    irPane?.mark(same);
    if (irLine !== null) irPane?.scrollTo(irLine);
    const wlines = same.map((l) => names.get(valueOfLine.get(l) ?? -1)).filter((x): x is number => x !== undefined);
    if (wgslLine !== null && !wlines.includes(wgslLine)) wlines.push(wgslLine);
    wgslPane?.mark(wlines);
    if (wlines.length) wgslPane?.scrollTo(wlines[0]);
    strip.replaceChildren();
    if (bit === undefined) {
      strip.append(irLine !== null ? 'This line carries no source instruction (a constant, or a value the passes made).' : '');
      return;
    }
    const text = ins ? listing[ins.line]?.trim() : undefined;
    const what = report.format === 'dxil' ? 'record' : 'word';
    strip.append(h('span.dim', `${bitPlace(bit)} · `), text ? h('code', text) : `${what} at ${bitPlace(bit)}`, h('span.dim', ` · ${same.length} IR line${same.length === 1 ? '' : 's'}`));
  };

  const left = lifted
    ? (irPane = codePane(lifted.text, lifted.kind === 'ir' ? 'ir' : 'wgsl', {
        linked: new Set(origin.keys()),
        label: 'lifted program',
        onLine: (l) => select(l, null),
      })).el
    : h('div.error-box', why.lifted ?? 'No lifted program.');
  const right = wgsl
    ? (wgslPane = codePane(wgsl, 'wgsl', { linked: new Set(names.values()), label: 'WGSL', onLine: (l) => select(null, l) })).el
    : h('div.error-box', h('strong', 'No WGSL: '), why.wgsl ?? '');
  const tie = names.size
    ? 'WGSL lines named after IR values are tied to them.'
    : lifted?.kind === 'ir'
      ? 'The WGSL writer keeps no source map, so WGSL lines are not tied to the IR here.'
      : 'This lift keeps no source words, so neither side is tied to the bytecode.';
  return h(
    'div.lift',
    h('div.lift-head', h('span', `${title}: ${lifted?.kind === 'ir' ? "iridia's IR, after specialise, structurize, promote, simplify and break_flags" : 'the module iridia lifted, as text'}`), h('span.dim', tie)),
    lifted?.kind === 'ir' ? strip : null,
    h('div.split', h('div.col', h('h3', lifted?.kind === 'ir' ? 'IR' : 'Program'), left), h('div.col', h('h3', 'WGSL'), right)),
  );
}


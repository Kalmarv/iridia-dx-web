// The lift: iridia's program text beside its WGSL. On the IR path each value's line carries the bytecode word it came
// from, so a line leads to its listed instruction and to every other line of that instruction; where the WGSL names
// values after the IR (`let v12`), its lines are tied to the IR's too.
import { h, hex } from '../dom';

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
  const instructionOf = (byte: number) => bc.instructions.find((i) => byte >= i.start && byte < i.end);
  const strip = h('div.origin-strip', lifted?.kind === 'ir' ? 'Click a line of the IR: its source instruction shows here, and every line it became is marked.' : '');
  const defs = lifted ? definitions(lifted.text) : new Map<number, number>();
  const names = wgsl ? wgslNames(wgsl) : new Map<number, number>();
  const valueOfLine = new Map([...defs].map(([v, l]) => [l, v]));
  const wgslLineValue = new Map([...names].map(([v, l]) => [l, v]));

  let irPane: ReturnType<typeof codePane> | null = null;
  let wgslPane: ReturnType<typeof codePane> | null = null;
  const select = (irLine: number | null, wgslLine: number | null) => {
    const value = irLine !== null ? valueOfLine.get(irLine) : wgslLine !== null ? wgslLineValue.get(wgslLine) : undefined;
    if (irLine === null && value !== undefined) irLine = defs.get(value) ?? null;
    const byte = irLine !== null ? origin.get(irLine) : undefined;
    const ins = byte !== undefined ? instructionOf(byte) : undefined;
    const same = byte !== undefined ? [...origin].filter(([, b]) => (ins ? b >= ins.start && b < ins.end : b === byte)).map(([l]) => l) : irLine !== null ? [irLine] : [];
    irPane?.mark(same);
    if (irLine !== null) irPane?.scrollTo(irLine);
    const wlines = same.map((l) => names.get(valueOfLine.get(l) ?? -1)).filter((x): x is number => x !== undefined);
    if (wgslLine !== null && !wlines.includes(wgslLine)) wlines.push(wgslLine);
    wgslPane?.mark(wlines);
    if (wlines.length) wgslPane?.scrollTo(wlines[0]);
    strip.replaceChildren();
    if (byte === undefined) {
      strip.append(irLine !== null ? 'This line carries no source word (a constant, or a value the passes made).' : '');
      return;
    }
    const text = ins ? listing[ins.line]?.trim() : undefined;
    strip.append(h('span.dim', `${hex(byte, 6)} · `), text ? h('code', text) : `word at ${hex(byte, 6)}`, h('span.dim', ` · ${same.length} IR line${same.length === 1 ? '' : 's'}`));
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
      ? 'naga writes no source map, so WGSL lines are not tied to the IR here.'
      : 'The naga path keeps no source words, so neither side is tied to the bytecode.';
  return h(
    'div.lift',
    h('div.lift-head', h('span', `${title}: ${lifted?.kind === 'ir' ? "iridia's IR, after specialise, promote and simplify" : 'the naga module iridia lifted, as text'}`), h('span.dim', tie)),
    lifted?.kind === 'ir' ? strip : null,
    h('div.split', h('div.col', h('h3', lifted?.kind === 'ir' ? 'IR' : 'Program'), left), h('div.col', h('h3', 'WGSL'), right)),
  );
}


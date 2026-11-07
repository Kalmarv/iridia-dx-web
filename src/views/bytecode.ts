// The bytes beside dx's listing: the file's regions (container parts, or a token stream's version, comments and code)
// banded over a hex dump, and each listed instruction tied to its bytes both ways.
import { bitPlace, h, hex, plural, scrollRowsIntoView } from '../dom';
import { listingLang } from '../highlight';
import type { Report } from '../types';
import { codePane } from './code';
import { DX } from '../marks';

const BAND = 8;

export function bytecodeView(report: Report, bytes: Uint8Array, focusByte: number | null = null): HTMLElement {
  const bc = report.bytecode;
  const regionAt = new Int16Array(bytes.length).fill(-1);
  // a later, narrower region (a part's data inside its part) wins
  bc.regions.forEach((r, i) => {
    for (let b = r.start; b < Math.min(r.end, bytes.length); b++) regionAt[b] = i;
  });
  // a byte two DXIL records share is the later one's: the one that starts in it
  const instrAt = new Int32Array(bytes.length).fill(-1);
  bc.instructions.forEach((ins, i) => {
    for (let b = ins.start; b < Math.min(ins.end, bytes.length); b++) instrAt[b] = i;
  });

  const cells: HTMLElement[] = [];
  const dump = h('div.hex-body');
  for (let row = 0; row < bytes.length; row += 16) {
    const line = h('div.hex-row', h('span.hex-off', hex(row, 6)));
    const ascii = h('span.hex-ascii');
    for (let k = 0; k < 16; k++) {
      const b = row + k;
      if (b >= bytes.length) {
        line.appendChild(h('span.hex-byte.empty', '  '));
        continue;
      }
      const r = regionAt[b];
      const cell = h(`span.hex-byte.band${r < 0 ? 'x' : r % BAND}`, { dataset: { b: String(b) } }, bytes[b].toString(16).padStart(2, '0'));
      cells[b] = cell;
      line.appendChild(cell);
      const c = bytes[b];
      ascii.appendChild(document.createTextNode(c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '·'));
    }
    line.appendChild(ascii);
    dump.appendChild(line);
  }
  const hexPane = h('div.hex', { tabIndex: 0, role: 'region', 'aria-label': 'bytes' }, dump);
  const status = h('div.status', 'Click an instruction or a byte.');

  let marked: HTMLElement[] = [];
  const markBytes = (start: number, end: number, cls = 'hl') => {
    for (const c of marked) c.classList.remove('hl', 'bad');
    marked = [];
    for (let b = start; b < end; b++) {
      const c = cells[b];
      if (c) {
        c.classList.add(cls);
        marked.push(c);
      }
    }
    const first = cells[start];
    const last = cells[Math.min(end, bytes.length) - 1] ?? first;
    if (first) scrollRowsIntoView(hexPane, first.parentElement as HTMLElement, last.parentElement as HTMLElement);
  };

  const listingText = 'Ok' in bc.listing ? bc.listing.Ok : null;
  const linked = new Set(bc.instructions.map((i) => i.line));
  const describe = (start: number, end: number, bits?: [number, number]) => {
    const r = regionAt[start];
    // a record that does not fill its bytes says which of their bits are its own
    const own = bits && (bits[0] % 8 || bits[1] % 8) ? ` · ${plural(bits[1] - bits[0], 'bit')} from ${bitPlace(bits[0])}` : '';
    status.textContent = `${hex(start, 6)}–${hex(end - 1, 6)} · ${plural(end - start, 'byte')}${own}${r >= 0 ? ` · ${bc.regions[r].label}` : ''}`;
  };
  const pane = listingText
    ? codePane(listingText, listingLang(report.format), {
        linked,
        label: 'disassembly',
        onLine: (line) => {
          const i = bc.instructions.findIndex((x) => x.line === line);
          pane!.mark([line]);
          if (i >= 0) {
            const ins = bc.instructions[i];
            markBytes(ins.start, ins.end);
            describe(ins.start, ins.end, ins.bits);
          } else status.textContent = report.format === 'dxil' ? 'This line is no instruction of a function body: only those are records tied to bits.' : 'This line decodes no instruction bytes of its own.';
        },
      })
    : null;
  dump.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest('.hex-byte') as HTMLElement | null;
    if (!cell?.dataset.b) return;
    const b = Number(cell.dataset.b);
    const i = instrAt[b];
    if (i >= 0 && pane) {
      const ins = bc.instructions[i];
      pane.mark([ins.line]);
      pane.scrollTo(ins.line);
      markBytes(ins.start, ins.end);
      describe(ins.start, ins.end, ins.bits);
    } else {
      const r = regionAt[b];
      if (r >= 0) {
        markBytes(bc.regions[r].start, bc.regions[r].end);
        describe(bc.regions[r].start, bc.regions[r].end);
      }
    }
  });

  const legend = h(
    'ul.regions',
    bc.regions.map((r, i) =>
      h(
        'li',
        h(
          'button.region',
          {
            type: 'button',
            on: {
              click: () => {
                markBytes(r.start, r.end);
                describe(r.start, r.end);
                // the listing shows the region's first instruction, where it has one
                const first = bc.instructions.find((x) => x.start >= r.start && x.start < r.end);
                if (first && pane) pane.scrollTo(first.line);
              },
            },
          },
          h(`span.swatch.band${i % BAND}`),
          h('span.region-label', r.label),
          h('span.region-size', plural(r.end - r.start, 'byte')),
        ),
      ),
    ),
  );

  const notes: HTMLElement[] = [];
  if (report.format === 'dxil' && bc.instructions.length) {
    notes.push(h('p.note', 'DXIL is LLVM bitcode: its instructions are bit-packed records, which start and end inside bytes, so a byte at the edge of two records is shared. A shared byte leads to the record that starts in it.'));
    if (bc.listed_part === 'ILDB') notes.push(h('p.note', 'The listing is of the ILDB part, the debug module, which dx lists where the container has one. iridia lifts the DXIL part, stored apart from it.'));
  } else if (report.format === 'dxil' && listingText) notes.push(h('p.note', 'dx could not place this listing\'s instructions in the bitcode, so its lines are not tied to bytes. The parts are.'));
  else if (!bc.instructions.length && listingText) notes.push(h('p.note', 'The listing could not be tied to bytes (its offset listing did not line up), so nothing is tied rather than something wrongly.'));
  if (focusByte !== null && focusByte < bytes.length) notes.push(h('p.note.bad', `The refusal names byte ${hex(focusByte, 6)}: marked in red.`));

  const listingEl = pane ? pane.el : h('div.error-box', h('strong', 'dx could not list this program: '), 'Err' in bc.listing ? bc.listing.Err : '');
  const view = h(
    'div.bytecode',
    h('div.bytecode-side', h('h3', 'Regions'), legend, notes),
    h('div.bytecode-hex', h('h3', `Bytes · ${plural(bytes.length, 'byte')}`), hexPane),
    h('div.bytecode-listing', h('h3.credit', h('img.credit-mark', { src: DX.mark, alt: '', width: DX.size[0], height: DX.size[1] }), report.format === 'dxil' ? 'dxc -dumpbin, as dx writes it' : 'D3DDisassemble, as dx writes it'), listingEl),
    status,
  );
  if (focusByte !== null && focusByte < bytes.length) requestAnimationFrame(() => markBytes(focusByte, focusByte + 4, 'bad'));
  return view;
}

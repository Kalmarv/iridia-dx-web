// A code pane: highlighted lines with a gutter, lines that can be marked, clicked and scrolled to.
import { h, scrollRowsIntoView } from '../dom';
import { highlightLines, type Lang } from '../highlight';

export interface Pane {
  el: HTMLElement;
  lines: HTMLElement[];
  mark(lines: Iterable<number>, cls?: string): void;
  scrollTo(line: number): void;
}

export function codePane(
  text: string,
  lang: Lang,
  opts: { onLine?: (line: number) => void; linked?: Set<number>; label?: string; start?: number } = {},
): Pane {
  const lines = highlightLines(text, lang);
  const body = h('div.code-body');
  lines.forEach((l, i) => {
    const row = h('div.code-row', { dataset: { line: String(i) } }, h('span.gutter', String(i + (opts.start ?? 1))), l);
    if (opts.linked?.has(i)) row.classList.add('linked');
    body.appendChild(row);
  });
  const rows = Array.from(body.children) as HTMLElement[];
  if (opts.onLine) {
    body.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('.code-row') as HTMLElement | null;
      if (row) opts.onLine!(Number(row.dataset.line));
    });
    body.classList.add('clickable');
  }
  const el = h('pre.code', { tabIndex: 0, 'aria-label': opts.label ?? 'code', role: 'region' }, body);
  const marked: Record<string, HTMLElement[]> = {};
  return {
    el,
    lines: rows,
    mark(which, cls = 'hl') {
      for (const r of marked[cls] ?? []) r.classList.remove(cls);
      marked[cls] = [];
      for (const i of which) {
        const r = rows[i];
        if (r) {
          r.classList.add(cls);
          marked[cls].push(r);
        }
      }
    },
    scrollTo(line) {
      const r = rows[line];
      if (r) scrollRowsIntoView(el, r);
    },
  };
}

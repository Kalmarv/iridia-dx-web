// A small element builder: h('div.class#id', {attrs}, ...children).

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { on?: Record<string, (e: any) => void> };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}` | `${K}#${string}`,
  attrs?: Attrs | Child,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  // the tag name, then `.class` and `#id` parts in any order
  const [name, ...parts] = tag.split(/(?=[.#])/);
  const el = document.createElement(name as K);
  const classes = parts.filter((p) => p.startsWith('.')).map((p) => p.slice(1));
  const id = parts.find((p) => p.startsWith('#'));
  if (id) el.id = id.slice(1);
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs as Child);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'on') {
        for (const [ev, f] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, f);
      } else if (k === 'class') {
        el.className = [el.className, v].filter(Boolean).join(' ');
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k === 'dataset' && typeof v === 'object') {
        Object.assign(el.dataset, v);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else if (v !== false && v !== null && v !== undefined) {
        if (k in el && !k.includes('-')) (el as any)[k] = v;
        else el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Bytes as `0x0000ABCD`. */
export const hex = (n: number, digits = 8): string => '0x' + n.toString(16).toUpperCase().padStart(digits, '0');

export const plural = (n: number, word: string, many = word + 's'): string => `${n} ${n === 1 ? word : many}`;

/**
 * Scroll `pane` so that the rows `first` to `last` (descendants of it) are in view: centred when they fit, their top
 * at the pane's top when they do not. Measured against the pane itself, not an offset parent.
 */
export function scrollRowsIntoView(pane: HTMLElement, first: HTMLElement, last: HTMLElement = first): void {
  const box = pane.getBoundingClientRect();
  const origin = box.top + pane.clientTop - pane.scrollTop;
  const top = first.getBoundingClientRect().top - origin;
  const bottom = last.getBoundingClientRect().bottom - origin;
  const target = bottom - top <= pane.clientHeight ? (top + bottom - pane.clientHeight) / 2 : top;
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  pane.scrollTo({ top: Math.max(0, Math.min(target, pane.scrollHeight - pane.clientHeight)), behavior });
}

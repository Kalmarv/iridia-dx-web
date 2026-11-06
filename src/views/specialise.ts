// Live specialisation: pin constant words or pipeline state and see what iridia folds, as a diff of the program text
// and of its WGSL. The preview draws the specialised program.
import type { Buffer, Field } from '../constants';
import { getLanes } from '../constants';
import { changed, diffLines, hunks } from '../diff';
import { h, plural } from '../dom';
import { highlightLines, type Lang } from '../highlight';
import type { Report, Specialisations, Specialised, StateInfo } from '../types';
import { err, ok } from '../types';

export interface SpecialiseState {
  /** Fields pinned, by buffer resource and offset. */
  pinned: Set<string>;
  /** Pipeline state values, by resource. */
  state: Map<number, [number, number, number, number]>;
}

export const fieldKey = (b: Buffer, f: Field): string => `${b.resource}:${f.offset}`;

export function diffView(before: string, after: string, lang: Lang): HTMLElement {
  const a = before.split('\n');
  const b = after.split('\n');
  const ops = diffLines(a, b);
  const { added, removed } = changed(ops);
  if (!added && !removed) return h('p.dim', 'No change: the pins decide nothing in this program.');
  const rows: HTMLElement[] = [];
  for (const hunk of hunks(ops)) {
    if (hunk.folded) {
      rows.push(h('div.diff-fold', `… ${plural(hunk.folded, 'unchanged line')} …`));
      continue;
    }
    for (const op of hunk.ops) {
      const [line] = highlightLines(op.text, lang);
      rows.push(h(`div.diff-row.${op.kind === '+' ? 'add' : op.kind === '-' ? 'del' : 'same'}`, h('span.diff-mark', op.kind), line));
    }
  }
  return h('div', h('p.diff-count', h('span.add-n', `+${added}`), ' ', h('span.del-n', `−${removed}`)), h('pre.code.diff', rows));
}

function stateLabel(s: StateInfo): string {
  const [name, stage] = Object.entries(s.param)[0];
  return `${name.replace(/_/g, ' ')} (stage ${stage})`;
}

export function specialiseView(
  report: Report,
  buffers: Buffer[],
  st: SpecialiseState,
  onChange: () => void,
): { el: HTMLElement; update(result: Specialisations | null, error?: string): void } {
  const pinnable = buffers.flatMap((b) => b.fields.filter((f) => !f.matrix && f.role?.kind !== 'time' && f.role?.kind !== 'mouse').map((f) => ({ b, f })));
  const fieldList = h(
    'ul.pins',
    pinnable.length
      ? pinnable.map(({ b, f }) => {
          const key = fieldKey(b, f);
          const box = h('input', {
            type: 'checkbox',
            checked: st.pinned.has(key),
            on: {
              change: () => {
                if (box.checked) st.pinned.add(key);
                else st.pinned.delete(key);
                onChange();
              },
            },
          });
          const value = getLanes(b, f)
            .map((x) => (Number.isInteger(x) ? String(x) : x.toFixed(3)))
            .join(', ');
          return h('li', h('label', box, h('code', f.name), h('span.dim', ` = ${value}`), f.read === false ? h('span.tag', 'not read') : null));
        })
      : h('li.dim', 'No constant to pin.'),
  );
  const stateList = h(
    'ul.pins',
    report.state.map((s) => {
      const lanes = st.state.get(s.resource) ?? s.default;
      const isFloat = 'bump_env_mat' in s.param || 'bump_l_scale' in s.param || 'bump_l_offset' in s.param;
      const width = 'bump_env_mat' in s.param ? 4 : 1;
      const f32 = new Float32Array(1);
      const u32 = new Uint32Array(f32.buffer);
      const shown = lanes.slice(0, width).map((w) => (isFloat ? ((u32[0] = w), f32[0]) : w));
      const inputs = shown.map((v, i) =>
        h('input.num', {
          type: 'number',
          step: isFloat ? '0.01' : '1',
          value: String(Math.round(v * 1000) / 1000),
          'aria-label': `${stateLabel(s)} lane ${i}`,
          on: {
            change: (e: Event) => {
              const x = Number((e.target as HTMLInputElement).value);
              const next = [...(st.state.get(s.resource) ?? s.default)] as [number, number, number, number];
              next[i] = isFloat ? ((f32[0] = x), u32[0]) : Math.max(0, Math.round(x));
              st.state.set(s.resource, next);
              onChange();
            },
          },
        }),
      );
      return h('li', h('span', stateLabel(s)), h('span.lanes', inputs), 'texture_dim' in s.param ? h('span.dim', ' (2 is 2D)') : null);
    }),
  );
  const results = h('div.spec-results', h('p.dim', 'Pin something to specialise.'));
  const el = h(
    'div.specialise',
    h(
      'div.spec-pins',
      h('h3', 'Constants'),
      h('p.dim', 'A pinned constant is folded where it decides a branch or a select (the naga path). The IR path folds pipeline state.'),
      fieldList,
      report.state.length ? [h('h3', 'Pipeline state'), h('p.dim', 'Always folded on the IR path: Direct3D 9’s defaults, or what you set here.'), stateList] : null,
    ),
    results,
  );

  const one = (title: string, r: { Ok: Specialised } | { Err: string } | null) => {
    if (!r) return null;
    const s = ok(r);
    if (!s) return h('section', h('h3', title), h('div.error-box', err(r) ?? ''));
    const facts = [
      s.folded !== null ? `${plural(s.folded, 'expression')} folded` : null,
      s.unread.length ? `no longer read: ${s.unread.join(', ')}` : null,
    ].filter(Boolean);
    const before = ok(s.wgsl_before);
    const after = ok(s.wgsl);
    return h(
      'section',
      h('h3', `${title} · by ${s.by}`),
      facts.length ? h('p', facts.join(' · ')) : null,
      s.ignored.length ? h('ul.notes', s.ignored.map((i) => h('li.dim', i))) : null,
      h('h4', 'Program'),
      diffView(s.before.text, s.lifted.text, s.lifted.kind === 'ir' ? 'ir' : 'wgsl'),
      h('h4', 'WGSL'),
      before && after ? diffView(before, after, 'wgsl') : h('div.error-box', err(s.wgsl) ?? err(s.wgsl_before) ?? 'No WGSL.'),
    );
  };

  return {
    el,
    update(result, error) {
      results.replaceChildren();
      if (error) {
        results.append(h('div.error-box', error));
        return;
      }
      if (!result) {
        results.append(h('p.dim', 'Pin something to specialise.'));
        return;
      }
      results.append(...[one('IR path', result.ir), one('naga path', result.naga)].filter((x): x is HTMLElement => !!x));
    },
  };
}

// The coverage route: what iridia decodes, lists, lifts, writes and runs, by feature and by public test suite, from
// docs/coverage/coverage.json (tools/coverage writes it, schema version 1; the page's build copies it beside the page).
import { h, plural } from './dom';

interface Counts { [k: string]: number }
interface Feature {
  format: string;
  kind: string;
  name: string;
  programs: number;
  decoded: string;
  listed: string;
  lifted: Counts;
  executed: Counts;
  wgsl: Counts;
  proved_by: string[];
}
interface Row { id: string; case: string; format: string; model: string; status: string; detail?: string }
interface Suite { id: string; name: string; source?: string; commit?: string; licence?: string; description?: string; totals: Counts; rows: Row[] }
interface Coverage { version: number; generated?: string; iridia?: string; dx?: string; features?: Feature[]; suites?: Suite[] }

const SUPPORTED = 1;
const KNOWN = ['pass', 'fail', 'refused', 'unsupported', 'not-modelled', 'compiler-refused', 'xfail', 'xpass'];
/** A status the page knows, or `other`: the generator may add classes. */
const statusClass = (s: string): string => (KNOWN.includes(s) ? s : 'other');
const ROWS_SHOWN = 400;

function ratio(c: Counts, good: string, bad: string): string {
  const g = c?.[good] ?? 0;
  const b = c?.[bad] ?? 0;
  return g + b ? `${g}/${g + b}` : '—';
}

function features(list: Feature[]): HTMLElement {
  const formats = [...new Set(list.map((f) => f.format))];
  const state = { format: formats[0] ?? '', text: '' };
  const body = h('tbody');
  const draw = () =>
    body.replaceChildren(
      ...list
        .filter((f) => f.format === state.format && (!state.text || f.name.toLowerCase().includes(state.text)))
        .map((f) =>
          h(
            'tr',
            h('td.mono', f.name),
            h('td', f.kind),
            h('td.num', String(f.programs)),
            h(`td.st-${f.decoded === 'yes' ? 'pass' : 'fail'}`, f.decoded),
            h(`td.st-${f.listed === 'exact' ? 'pass' : f.listed === 'differs' ? 'fail' : 'other'}`, f.listed),
            h('td.mono', ratio(f.lifted, 'ok', 'refused')),
            h('td.mono', ratio(f.wgsl, 'ok', 'failed')),
            h('td.mono', ratio(f.executed, 'pass', 'fail')),
            h('td.small', f.proved_by.join(', ')),
          ),
        ),
    );
  draw();
  return h(
    'section',
    h('h2', 'By feature'),
    h('p.dim', 'Each opcode, stage and construct of the corpus: decoded by dx, listed as Microsoft’s tools list it, lifted, written as WGSL and run by iridia (programs ok of those tried), and the suites whose tests prove it.'),
    h(
      'div.filters',
      h(
        'div.seg-group',
        { role: 'group', 'aria-label': 'format' },
        formats.map((f) => {
          const b = h('button.seg', { type: 'button', 'aria-pressed': String(f === state.format), on: { click: () => ((state.format = f), b.parentElement?.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))), draw()) } }, f.toUpperCase());
          return b;
        }),
      ),
      h('input', { type: 'search', placeholder: 'Filter features', 'aria-label': 'filter features', on: { input: (e: Event) => ((state.text = (e.target as HTMLInputElement).value.toLowerCase()), draw()) } }),
    ),
    h('div.table-scroll', h('table.data', h('thead', h('tr', ['Feature', 'Kind', 'Programs', 'Decoded', 'Listed', 'Lifted', 'WGSL', 'Executed', 'Proved by'].map((t) => h('th', t)))), body)),
  );
}

function suite(s: Suite): HTMLElement {
  const statuses = [...new Set(s.rows.map((r) => r.status))];
  const state = { status: new Set(statuses.filter((x) => x !== 'pass')), text: '' };
  const body = h('tbody');
  const more = h('p.dim');
  const draw = () => {
    const rows = s.rows.filter((r) => state.status.has(r.status) && (!state.text || `${r.case} ${r.detail ?? ''}`.toLowerCase().includes(state.text)));
    body.replaceChildren(...rows.slice(0, ROWS_SHOWN).map((r) => h('tr', h('td.mono', r.case), h('td', r.format), h('td.mono', r.model), h(`td.st-${statusClass(r.status)}`, r.status), h('td.small', r.detail ?? ''))));
    more.textContent = rows.length > ROWS_SHOWN ? `Showing ${ROWS_SHOWN} of ${rows.length}: filter to see the rest.` : `${plural(rows.length, 'case')} shown.`;
  };
  draw();
  const total = Object.values(s.totals ?? {}).reduce((a, b) => a + b, 0);
  return h(
    'section.suite',
    h('h2', s.source ? h('a', { href: s.source, rel: 'noopener' }, s.name) : s.name),
    s.description ? h('p.lede', s.description) : null,
    h('p.dim.small', [s.commit ? `at ${s.commit.slice(0, 10)}` : '', s.licence ? `· ${s.licence}` : ''].join(' ')),
    h('div.bar', { role: 'img', 'aria-label': Object.entries(s.totals ?? {}).map(([k, n]) => `${n} ${k}`).join(', ') }, Object.entries(s.totals ?? {}).filter(([, n]) => n).map(([k, n]) => h(`span.seg-bar.st-bg-${statusClass(k)}`, { style: { flexGrow: String(n) }, title: `${n} ${k}` }))),
    h('p.counts', Object.entries(s.totals ?? {}).filter(([, n]) => n).map(([k, n]) => h(`span.count.st-${statusClass(k)}`, `${n} ${k}`)), h('span.dim', ` of ${plural(total, 'run')}`)),
    h(
      'div.filters',
      statuses.map((st) =>
        h(
          'label.toggle',
          h('input', { type: 'checkbox', checked: state.status.has(st), on: { change: (e: Event) => ((e.target as HTMLInputElement).checked ? state.status.add(st) : state.status.delete(st), draw()) } }),
          ` ${st}`,
        ),
      ),
      h('input', { type: 'search', placeholder: 'Filter cases', 'aria-label': `filter ${s.name} cases`, on: { input: (e: Event) => ((state.text = (e.target as HTMLInputElement).value.toLowerCase()), draw()) } }),
    ),
    h('div.table-scroll', h('table.data', h('thead', h('tr', ['Case', 'Format', 'Model', 'Status', 'Why'].map((t) => h('th', t)))), body)),
    more,
  );
}

export async function coverageView(): Promise<HTMLElement> {
  let data: Coverage;
  try {
    const r = await fetch('./coverage.json');
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    data = await r.json();
  } catch (e) {
    return h('div.page', h('h1', 'Coverage'), h('div.error-box', `The coverage table did not load: ${e instanceof Error ? e.message : e}`));
  }
  if (data.version !== SUPPORTED)
    return h('div.page', h('h1', 'Coverage'), h('div.error-box', `The coverage table is schema version ${data.version}; this page reads version ${SUPPORTED}.`));
  return h(
    'div.page.coverage',
    h('h1', 'Coverage'),
    h('p.lede', `What iridia and dx do with a corpus and with public shader test suites${data.generated ? `, generated ${data.generated.slice(0, 10)}` : ''}${data.iridia ? ` from iridia ${data.iridia.slice(0, 7)}` : ''}${data.dx ? ` and dx ${data.dx}` : ''}.`),
    data.features?.length ? features(data.features) : null,
    (data.suites ?? []).map(suite),
  );
}

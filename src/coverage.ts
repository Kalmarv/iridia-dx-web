// The coverage route: what dx and iridia do with each bytecode construct and with each run of two public shader test
// suites, from iridia's coverage table (schema version 1, written by its `iridia-coverage table`) at the commit the
// glue pins. scripts/assets.mjs fetches it into the build as coverage.json; __IRIDIA_REV__ names that commit.
import { append, h, plural } from './dom';

interface Counts { [k: string]: number }
interface Feature {
  format: string;
  kind: string;
  name: string;
  programs: number;
  decoded_counts: { ok: number; failed: number };
  listed_counts: { exact: number; differs: number; unchecked: number };
  lifted: { ok: number; refused: number };
  wgsl: { ok: number; failed: number };
  executed: { pass: number; fail: number };
  proved_by: string[];
}
interface Row { id: string; case: string; runner?: string; format: string; model: string; status: string; detail: string; probes?: number; selected?: boolean }
interface Suite {
  id: string;
  name: string;
  source?: string;
  commit?: string;
  licence?: string;
  totals: Counts;
  probe_totals?: Counts;
  extended_totals?: Counts;
  rows: Row[];
}
interface Coverage { version: number; iridia: string; dx: string; graded?: unknown; features: Feature[]; suites: Suite[] }

const SUPPORTED = 1;
const ROWS_SHOWN = 400;
const IRIDIA = 'https://github.com/Kalmarv/iridia';

/** Each outcome's mark, label and meaning: the mark and label say it, the colour only repeats it. */
const OUTCOMES: Record<string, { mark: string; label: string; means: string }> = {
  pass: { mark: '✓', label: 'pass', means: 'every probe held, against the suite’s expected values or golden images' },
  fail: { mark: '✗', label: 'fail', means: 'a probe read otherwise' },
  error: { mark: '!', label: 'error', means: 'the lift, the WGSL or the executor failed on the program' },
  refused: { mark: '⊘', label: 'refused', means: 'iridia’s lifter names a construct of the program it does not lift' },
  'not-modelled': { mark: '◌', label: 'not modelled', means: 'the runner lacks a pipeline feature the test needs, such as amplification or stencil' },
  'compiler-refused': { mark: '⊗', label: 'compiler refused', means: 'Microsoft’s compiler refused or crashed on the test’s shader, so there is no program to run' },
  unsupported: { mark: '–', label: 'unsupported', means: 'the test’s own REQUIRES or UNSUPPORTED lines leave it out for this executor' },
  xfail: { mark: '≈', label: 'xfail', means: 'the test’s own XFAIL line expects it to fail here' },
  untested: { mark: '○', label: 'not run', means: 'no run that uses it reached a probe' },
};
/** The order outcomes are listed in, worst first; one the page does not know goes last under its own name. */
const ORDER = ['fail', 'error', 'refused', 'not-modelled', 'compiler-refused', 'untested', 'unsupported', 'xfail', 'pass'];
const known = (s: string) => (s in OUTCOMES ? s : 'other');
const ordered = (list: Iterable<string>) => [...new Set(list)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
const rank = (s: string) => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
const n = (x: number) => x.toLocaleString('en-US');

/** An outcome as its mark and label, coloured by its class and titled with what it means. */
function outcome(status: string): HTMLElement {
  const o = OUTCOMES[status] ?? { mark: '?', label: status, means: status };
  return h(`span.outcome.st-${known(status)}`, { title: o.means, dataset: { status } }, h('span.mark', { 'aria-hidden': 'true' }, o.mark), ` ${o.label}`);
}

/** A feature's outcome, worst first: a failed probe or listing, then an error, then a refusal, then whether it ran. */
function featureOutcome(f: Feature): { status: string; why: string } {
  const why: string[] = [];
  const of = (k: number, total: number, what: string) => why.push(`${n(k)} of ${n(total)} ${what}`);
  const programs = f.programs;
  if (f.listed_counts.differs) of(f.listed_counts.differs, programs, 'listings differ from Microsoft’s');
  if (f.executed.fail) of(f.executed.fail, f.executed.pass + f.executed.fail, 'probes failed in runs that use it');
  if (f.decoded_counts.failed) of(f.decoded_counts.failed, programs, 'programs not decoded by dx');
  if (f.wgsl.failed) of(f.wgsl.failed, f.wgsl.ok + f.wgsl.failed, 'programs’ WGSL failed');
  if (f.lifted.refused) of(f.lifted.refused, programs, 'programs refused by the lifter');
  const status =
    f.listed_counts.differs || f.executed.fail ? 'fail'
    : f.decoded_counts.failed || f.wgsl.failed ? 'error'
    : f.lifted.refused ? 'refused'
    : f.executed.pass ? 'pass'
    : 'untested';
  if (status === 'untested') why.push(f.lifted.ok ? `lifted in ${plural(f.lifted.ok, 'program')}, but no run that uses it reached a probe` : 'no program that uses it was lifted');
  return { status, why: why.join('; ') };
}

/** A row of toggle buttons, one pressed at a time: `pick` gets the pressed value. */
function segments(label: string, options: [string, string][], pick: (v: string) => void): HTMLElement {
  const group = h('div.seg-group', { role: 'group', 'aria-label': label });
  for (const [value, text] of options) {
    const b = h('button.seg', {
      type: 'button',
      'aria-pressed': String(value === options[0][0]),
      on: { click: () => (group.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))), pick(value)) },
    }, text);
    group.append(b);
  }
  return h('div.filter', h('span.filter-label', { 'aria-hidden': 'true' }, label), group);
}

/** Checkboxes, one per outcome, each with how many of the filtered rows have it (`counts` sets the numbers). */
function outcomeToggles(statuses: string[], on: Set<string>, changed: () => void) {
  const numbers = new Map<string, HTMLElement>();
  const el = h(
    'fieldset.filter.outcomes',
    h('legend.filter-label', 'Outcome'),
    statuses.map((st) => {
      const count = h('span.dim');
      numbers.set(st, count);
      return h('label.toggle', h('input', { type: 'checkbox', checked: on.has(st), value: st, on: { change: (e: Event) => ((e.target as HTMLInputElement).checked ? on.add(st) : on.delete(st), changed()) } }), outcome(st), count);
    }),
  );
  const counts = (by: Map<string, number>) => numbers.forEach((c, st) => (c.textContent = ` ${n(by.get(st) ?? 0)}`));
  return { el, counts };
}

const tally = <T>(list: T[], key: (x: T) => string) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map<string, number>());
const search = (label: string, set: (text: string) => void) =>
  h('input', { type: 'search', placeholder: label, 'aria-label': label, on: { input: (e: Event) => set((e.target as HTMLInputElement).value.trim().toLowerCase()) } });

/** Each suite's runs by outcome: the bar, then each count with its mark; vkd3d's extended runs apart. */
function totals(s: Suite): HTMLElement {
  const runs = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
  const entries = ordered(Object.keys(s.totals)).map((k) => [k, s.totals[k]] as const).filter(([, c]) => c);
  const total = runs(s.totals);
  const probes = s.probe_totals ? ordered(Object.keys(s.probe_totals)).map((k) => `${n(s.probe_totals![k])} ${OUTCOMES[k]?.label ?? k}`) : [];
  return h(
    'section.suite-totals',
    { 'aria-labelledby': `totals-${s.id}` },
    h('h3', { id: `totals-${s.id}` }, s.source ? h('a', { href: s.source, rel: 'noopener' }, s.name) : s.name),
    h('p.dim.small', [s.commit, s.licence].filter(Boolean).join(' · ')),
    h('div.bar', { 'aria-hidden': 'true' }, entries.map(([k, c]) => h(`span.seg-bar.st-bg-${known(k)}`, { style: { flexGrow: String(c) } }))),
    h('p.counts', entries.map(([k, c]) => h('span.count', outcome(k), ` ${n(c)}`)), h('span.dim', ` of ${n(total)} runs`)),
    probes.length ? h('p.dim.small', `Their probes: ${probes.join(', ')}.`) : null,
    s.extended_totals
      ? h('p.small.extended-note', `Counted here: the ${n(total)} runs vkd3d’s own Windows runners make (selected). Not counted: ${n(runs(s.extended_totals))} extended runs, the same tests at models vkd3d’s runs leave out, which need not hold on any device; tick “Extended runs” under Runs to list them.`)
      : null,
  );
}

function featureTable(list: Feature[], suites: Suite[]): HTMLElement {
  const rows = list.map((f) => ({ f, ...featureOutcome(f) }));
  const statuses = ordered(rows.map((r) => r.status));
  const state = { format: '', kind: '', suite: '', outcomes: new Set(statuses), text: '' };
  const body = h('tbody');
  const shown = h('p.dim.small', { role: 'status' });
  const toggles = outcomeToggles(statuses, state.outcomes, () => draw());
  const draw = () => {
    const base = rows.filter(
      ({ f }) =>
        (!state.format || f.format === state.format) &&
        (!state.kind || f.kind === state.kind) &&
        (!state.suite || (state.suite === '-' ? !f.proved_by.length : f.proved_by.includes(state.suite))) &&
        (!state.text || f.name.toLowerCase().includes(state.text)),
    );
    toggles.counts(tally(base, (r) => r.status));
    const picked = base.filter((r) => state.outcomes.has(r.status));
    body.replaceChildren(
      ...picked.map(({ f, status, why }) =>
        h(
          'tr',
          h('td', outcome(status)),
          h('td.mono', f.name),
          h('td', f.format.toUpperCase()),
          h('td', f.kind),
          h('td.num', n(f.programs)),
          h('td.num.mono', `${n(f.lifted.ok)}/${n(f.programs)}`),
          h('td.num.mono', `${n(f.wgsl.ok)}/${n(f.wgsl.ok + f.wgsl.failed)}`),
          h('td.num.mono', `${n(f.executed.pass)}/${n(f.executed.pass + f.executed.fail)}`),
          h('td.small', f.proved_by.join(', ') || '—'),
          h('td.small', why),
        ),
      ),
    );
    shown.textContent = `${plural(picked.length, 'feature')} shown of ${n(list.length)}.`;
  };
  const formats = ordered(list.map((f) => f.format));
  const kinds = [...new Set(list.map((f) => f.kind))];
  draw();
  return h(
    'section',
    h('h2', 'By feature'),
    h('p.dim', 'One row per bytecode construct: each opcode, dx.op and shader stage the suites’ programs use. Lifted and WGSL count programs; Executed counts the probes of the runs that use it. A feature’s outcome is its worst: a failed probe or listing, then an error, then a refusal.'),
    h(
      'div.filters',
      segments('Format', [['', 'All'], ...formats.map((f): [string, string] => [f, f.toUpperCase()])], (v) => ((state.format = v), draw())),
      segments('Kind', [['', 'All'], ...kinds.map((k): [string, string] => [k, k === 'stage' ? 'Stages' : `${k[0].toUpperCase()}${k.slice(1)}s`])], (v) => ((state.kind = v), draw())),
      segments('Proved by', [['', 'Any'], ...suites.map((s): [string, string] => [s.id, s.id]), ['-', 'Neither']], (v) => ((state.suite = v), draw())),
      search('Filter features', (t) => ((state.text = t), draw())),
    ),
    toggles.el,
    shown,
    h('div.table-scroll', h('table.data.features', h('thead', h('tr', ['Outcome', 'Feature', 'Format', 'Kind', 'Programs', 'Lifted', 'WGSL', 'Executed', 'Proved by', 'Why'].map((t) => h('th', { scope: 'col' }, t)))), body)),
  );
}

function runTable(suites: Suite[]): HTMLElement {
  const state = { suite: suites[0], runner: '', extended: false, outcomes: new Set<string>(), text: '' };
  const body = h('tbody');
  const shown = h('p.dim.small', { role: 'status' });
  const slot = h('div.filters');
  let toggles: ReturnType<typeof outcomeToggles>;
  const draw = () => {
    const s = state.suite;
    const base = s.rows.filter(
      (r) =>
        (state.extended || r.selected !== false) &&
        (!state.runner || r.runner === state.runner) &&
        (!state.text || `${r.case} ${r.model} ${r.detail}`.toLowerCase().includes(state.text)),
    );
    toggles.counts(tally(base, (r) => r.status));
    const picked = base.filter((r) => state.outcomes.has(r.status));
    body.replaceChildren(
      ...picked.slice(0, ROWS_SHOWN).map((r) =>
        h(
          'tr',
          h('td', outcome(r.status), r.selected === false ? h('span.tag', ' extended') : null),
          h('td.mono', r.case),
          h('td', r.runner ?? '—'),
          h('td', r.format ? r.format.toUpperCase() : '—'),
          h('td.mono', r.model),
          h('td.num', r.probes === undefined ? '—' : n(r.probes)),
          h('td.small.why', r.detail || '—'),
        ),
      ),
    );
    shown.textContent = picked.length > ROWS_SHOWN ? `${n(ROWS_SHOWN)} runs shown of the ${n(picked.length)} picked: filter to see the rest.` : `${plural(picked.length, 'run')} shown.`;
  };
  /** The suite's own filters, each at its start: its runners, its outcomes (all but pass), extended runs, the search. */
  const filters = () => {
    const s = state.suite;
    const statuses = ordered(s.rows.map((r) => r.status));
    state.outcomes = new Set(statuses.filter((x) => x !== 'pass'));
    state.runner = '';
    state.extended = false;
    state.text = '';
    toggles = outcomeToggles(statuses, state.outcomes, draw);
    const runners = [...new Set(s.rows.flatMap((r) => (r.runner ? [r.runner] : [])))];
    slot.replaceChildren();
    append(slot, [
      runners.length > 1 ? segments('Runner', [['', 'All'], ...runners.map((r): [string, string] => [r, r])], (v) => ((state.runner = v), draw())) : null,
      s.rows.some((r) => r.selected === false)
        ? h('label.toggle', h('input', { type: 'checkbox', checked: state.extended, on: { change: (e: Event) => ((state.extended = (e.target as HTMLInputElement).checked), draw()) } }), ' Extended runs')
        : null,
      search(`Filter ${s.id} runs`, (t) => ((state.text = t), draw())),
      toggles.el,
    ]);
    draw();
  };
  filters();
  return h(
    'section',
    h('h2', 'Runs'),
    h('p.dim', 'One row per run of a suite’s test, with the reason for each outcome but pass: the probe that decided it, or what the lifter or runner could not do. Passing runs are hidden to start.'),
    h('div.filters', segments('Suite', suites.map((s): [string, string] => [s.id, s.name]), (v) => ((state.suite = suites.find((s) => s.id === v)!), filters()))),
    slot,
    shown,
    h('div.table-scroll', h('table.data.runs', h('thead', h('tr', ['Outcome', 'Case', 'Runner', 'Format', 'Model', 'Probes', 'Why'].map((t) => h('th', { scope: 'col' }, t)))), body)),
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
  const rev = __IRIDIA_REV__;
  const table = `${IRIDIA}/blob/${rev}/docs/coverage`;
  return h(
    'div.page.coverage',
    h('h1', 'Coverage'),
    h(
      'p.lede',
      'What dx and iridia do with the programs of two public shader test suites: each run of their tests, and each bytecode construct those programs use. From ',
      h('a', { href: `${table}/coverage.md`, rel: 'noopener' }, 'iridia’s coverage table'),
      ` (iridia ${data.iridia}, dx’s ${data.dx}) at commit `,
      h('a.mono', { href: `${IRIDIA}/commit/${rev}`, rel: 'noopener' }, rev.slice(0, 7)),
      ', the commit this page’s iridia is built from.',
    ),
    // tables of schema version 1 that name no graded path grade iridia's older lift (iridia_dxbc::lift and
    // iridia_dxil::lift, WGSL from iridia::emit), not the IR path the page's other views use
    data.graded
      ? null
      : h(
          'div.note-box.graded-note',
          h('strong', 'Which lift this grades: '),
          'this table grades iridia’s older lift, which writes WGSL through naga, not the IR path the rest of this page uses. Its refusals and errors are that lift’s, and the IR path lifts some of those programs: doubles, for one. A table of the IR path will replace it.',
        ),
    h('section', h('h2', 'Runs by outcome'), h('div.totals', data.suites.map(totals))),
    h('details.legend', h('summary', 'What each outcome means'), h('dl', ORDER.map((k) => [h('dt', outcome(k)), h('dd', OUTCOMES[k].means)]))),
    featureTable(data.features, data.suites),
    runTable(data.suites),
  );
}

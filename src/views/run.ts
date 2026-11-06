// Execution: what the GPU wrote at a pixel beside what iridia's CPU executors compute from the same inputs (A = B = C).
import { bitsFloat } from '../constants';
import { h, hex } from '../dom';
import type { Executed, Interface } from '../types';
import { err, ok } from '../types';

type Words = [number, number, number, number];

export interface PixelRun {
  kind: 'pixel' | 'vertex' | 'compute';
  /** What was run: `pixel (412, 230) of the quad at (412, 230)`. */
  where: string;
  /** The lane of the quad clicked (0 for a single invocation). */
  lane: number;
  iface: Interface;
  /** The interface inputs given to the executors, by index. */
  inputs: Words[];
  /** The GPU's value of each interface output, by index (null where it wrote none to read); null for a run with no GPU. */
  gpu: (Words | null)[] | null;
  /** Where the inputs came from, where not read back from the GPU. */
  inputsFrom?: string;
  gpuNote?: string;
  executed: Executed[];
  covered: boolean;
}

const LANES = 'xyzw';

/** The distance in units in the last place between two f32 bit patterns. */
function ulps(a: number, b: number): number {
  const ord = (w: number) => (w & 0x80000000 ? -(w & 0x7fffffff) : w);
  return Math.abs(ord(a >>> 0) - ord(b >>> 0));
}

function show(w: number | undefined, scalar: string): string {
  if (w === undefined) return '—';
  if (scalar === 'float') {
    const f = bitsFloat(w);
    return Number.isFinite(f) ? String(Math.abs(f) < 1e-4 && f !== 0 ? f.toExponential(4) : Math.round(f * 1e6) / 1e6) : String(f);
  }
  if (scalar === 'sint') return String(w | 0);
  return String(w >>> 0);
}

function cell(w: number | undefined, ref: number | undefined, scalar: string, against = 'the GPU'): HTMLElement {
  const text = show(w, scalar);
  if (w === undefined || ref === undefined) return h('td.mono', text);
  const same = w >>> 0 === ref >>> 0;
  const d = scalar === 'float' && !same ? ulps(w, ref) : 0;
  return h(
    `td.mono.${same ? 'eq' : d <= 4 ? 'near' : 'ne'}`,
    { title: `${hex(w >>> 0)}${same ? ` · the same bits as ${against}` : scalar === 'float' ? ` · ${d} ulp from ${against}` : ` · differs from ${against}`}` },
    text,
    same ? h('span.mark', ' =') : h('span.mark', scalar === 'float' ? ` ${d} ulp` : ' ≠'),
  );
}

export function runView(r: PixelRun | null, help: string, error?: string, running?: string): HTMLElement {
  if (running) return h('div.run', h('div.loading', h('div.spinner', { 'aria-hidden': 'true' }), h('p', { role: 'status' }, running)));
  if (error) return h('div.run', h('div.error-box', error));
  if (!r) return h('div.run', h('p.lede', help));
  const exec = r.executed.map((e) => ({ e, lane: ok(e.lanes)?.[r.lane] ?? null, why: err(e.lanes) }));
  const gpu = r.gpu;
  if (gpu === null) return cpuOnly(r, exec);
  const rows: HTMLElement[] = [];
  let all = 0;
  let equal = 0;
  r.iface.outputs.forEach((v, o) => {
    const g = gpu[o] ?? null;
    for (let l = 0; l < v.value.width; l++) {
      const gw = g?.[l];
      const cpu = exec.map((x) => x.lane?.outputs[o]?.[l]);
      all += cpu.filter((c) => c !== undefined).length;
      equal += cpu.filter((c) => c !== undefined && gw !== undefined && c >>> 0 === gw >>> 0).length;
      rows.push(h('tr', h('td.mono', `${v.label.name}${v.label.index}.${LANES[l]}`), h('td.mono', show(gw, v.value.scalar)), ...cpu.map((c) => cell(c, gw, v.value.scalar))));
    }
  });
  const killed = exec.filter((x) => x.lane?.killed).map((x) => x.e.executor);
  const verdict =
    !r.covered && r.kind !== 'compute'
      ? h('p.verdict.ne', 'No fragment there: click on the drawn surface.')
      : all && equal === all
        ? h('p.verdict.eq', `A = B = C: every lane has the same bits on the GPU and in ${exec.length === 1 ? 'the CPU executor' : 'both CPU executors'}.`)
        : all
          ? h('p.verdict.near', `${equal} of ${all} CPU lanes have the GPU’s bits. A filtered texture sample can differ in the last bits (GPU filter weights are fixed-point), and so can the GPU’s own sin, cos, exp and log.`)
          : null;
  return h(
    'div.run',
    h('p.lede', r.where),
    verdict,
    killed.length ? h('p', `Discarded by ${killed.join(' and ')}.`) : null,
    h(
      'table.data.run-table',
      h('thead', h('tr', h('th', 'Output lane'), h('th', 'A · GPU (WebGPU)'), ...exec.map((x, i) => h('th', `${'BC'[i] ?? '?'} · ${x.e.executor}`, h('div.dim.small', x.e.runs))))),
      h('tbody', rows),
    ),
    r.gpuNote ? h('p.note', r.gpuNote) : null,
    exec.filter((x) => x.why).map((x) => h('div.error-box', h('strong', `${x.e.executor}: `), x.why)),
    inputsTable(r, r.inputsFrom ?? 'Read back from the GPU: what the pixel program received there, bit for bit.'),
  );
}

function inputsTable(r: PixelRun, from: string): HTMLElement[] {
  return [
    h('h3', 'Inputs given to the executors'),
    h('p.dim', from),
    h(
      'table.data',
      h('thead', h('tr', h('th', 'Input'), h('th', 'x'), h('th', 'y'), h('th', 'z'), h('th', 'w'))),
      h(
        'tbody',
        r.iface.inputs.map((v, i) => h('tr', h('td.mono', `${v.label.name}${v.label.index}`), ...[0, 1, 2, 3].map((l) => h('td.mono', l < v.value.width ? show(r.inputs[i]?.[l], v.value.scalar) : '')))),
      ),
    ),
  ];
}

type Lane = { e: Executed; lane: { outputs: (Words | null)[]; killed: boolean } | null; why: string | undefined };

/** A run with no GPU beside it: each executor's outputs, the second compared with the first where there are two. */
function cpuOnly(r: PixelRun, exec: Lane[]): HTMLElement {
  const rows: HTMLElement[] = [];
  let all = 0;
  let equal = 0;
  r.iface.outputs.forEach((v, o) => {
    for (let l = 0; l < v.value.width; l++) {
      const cpu = exec.map((x) => x.lane?.outputs[o]?.[l]);
      const first = cpu[0];
      if (cpu.length > 1 && cpu[1] !== undefined && first !== undefined) {
        all++;
        if (cpu[1] >>> 0 === first >>> 0) equal++;
      }
      rows.push(h('tr', h('td.mono', `${v.label.name}${v.label.index}.${LANES[l]}`), ...cpu.map((c, i) => (i === 0 ? h('td.mono', show(c, v.value.scalar)) : cell(c, first, v.value.scalar, 'B')))));
    }
  });
  const killed = exec.filter((x) => x.lane?.killed).map((x) => x.e.executor);
  return h(
    'div.run',
    h('p', r.where),
    all ? h(`p.verdict.${equal === all ? 'eq' : 'near'}`, equal === all ? 'Both CPU executors give the same bits.' : `${equal} of ${all} lanes have the same bits in both CPU executors.`) : null,
    killed.length ? h('p', `Discarded by ${killed.join(' and ')}.`) : null,
    h(
      'table.data.run-table',
      h('thead', h('tr', h('th', 'Output lane'), ...exec.map((x) => h('th', x.e.executor, h('div.dim.small', x.e.runs))))),
      h('tbody', rows),
    ),
    exec.filter((x) => x.why).map((x) => h('div.error-box', h('strong', `${x.e.executor}: `), x.why)),
    inputsTable(r, r.inputsFrom ?? ''),
  );
}


// A line diff (Myers' O(ND) greedy algorithm), shown unified with folded context.

export type Op = { kind: ' ' | '-' | '+'; text: string; a?: number; b?: number };

export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) x = v[max + k + 1];
      else x = v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  trace.push(v.slice());
  // walk back
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[max + k - 1] < vv[max + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[max + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', text: a[x - 1], a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      ops.push({ kind: '+', text: b[y - 1], b: y - 1 });
      y--;
    } else {
      ops.push({ kind: '-', text: a[x - 1], a: x - 1 });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: ' ', text: a[x - 1], a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  return ops.reverse();
}

export interface Hunk { ops: Op[]; folded?: number }

/** The diff with runs of unchanged lines longer than `2 * context` folded to their ends. */
export function hunks(ops: Op[], context = 3): Hunk[] {
  const out: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind !== ' ') {
      const start = i;
      while (i < ops.length && ops[i].kind !== ' ') i++;
      out.push({ ops: ops.slice(start, i) });
      continue;
    }
    const start = i;
    while (i < ops.length && ops[i].kind === ' ') i++;
    const run = ops.slice(start, i);
    const head = start === 0 ? 0 : context;
    const tail = i === ops.length ? 0 : context;
    if (run.length > head + tail + 1) {
      if (head) out.push({ ops: run.slice(0, head) });
      out.push({ ops: [], folded: run.length - head - tail });
      if (tail) out.push({ ops: run.slice(run.length - tail) });
    } else {
      out.push({ ops: run });
    }
  }
  return out;
}

export const changed = (ops: Op[]): { added: number; removed: number } => ({
  added: ops.filter((o) => o.kind === '+').length,
  removed: ops.filter((o) => o.kind === '-').length,
});

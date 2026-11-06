// The page's constant buffers: one word array per constant buffer resource, the fields the reflection names in it,
// which of them the page drives itself (time, mouse, camera matrices) and which the controls set.
import type { Analyses, ConstantType, Interface, MatrixLines, Resource, Scalar } from './types';

export type Role =
  | { kind: 'time' }
  | { kind: 'mouse' }
  | { kind: 'resolution' }
  | { kind: 'texel-size' }
  | { kind: 'eye' }
  | { kind: 'matrix'; which: MatrixRole; lines: MatrixLines | null };

export type MatrixRole = 'world' | 'view' | 'projection' | 'view-projection' | 'world-view' | 'world-view-projection';

export interface Field {
  name: string;
  /** Byte offset in its buffer. */
  offset: number;
  scalar: Scalar;
  /** Lanes of a scalar or vector. */
  width: number;
  /** A matrix: its stored lines, their length and stride. */
  matrix?: { rows: number; columns: number; major: 'row' | 'column'; stride: number };
  role: Role | null;
  /** Whether the program reads any of its words (where the analyses say). */
  read: boolean | null;
}

export interface Buffer {
  resource: number;
  name: string;
  register: number | null;
  words: Uint32Array;
  fields: Field[];
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const i32 = new Int32Array(f32.buffer);
export const floatBits = (x: number): number => ((f32[0] = x), u32[0]);
export const bitsFloat = (w: number): number => ((u32[0] = w), f32[0]);
export const bitsInt = (w: number): number => ((u32[0] = w), i32[0]);

/** A lane value as the word the field's scalar stores. */
export function word(scalar: Scalar, value: number): number {
  switch (scalar) {
    case 'float':
      return floatBits(value);
    case 'bool':
      return value ? 1 : 0;
    case 'sint':
      return value | 0;
    default:
      return Math.max(0, Math.round(value)) >>> 0;
  }
}

/** A word as the field's scalar reads it. */
export function lane(scalar: Scalar, w: number): number {
  switch (scalar) {
    case 'float':
      return bitsFloat(w);
    case 'sint':
      return bitsInt(w);
    default:
      return w >>> 0;
  }
}

function flatten(name: string, offset: number, ty: ConstantType, out: Omit<Field, 'role' | 'read'>[]): void {
  if ('scalar' in ty) out.push({ name, offset, scalar: ty.scalar, width: 1 });
  else if ('vector' in ty) out.push({ name, offset, scalar: ty.vector.scalar, width: ty.vector.width });
  else if ('matrix' in ty) {
    const m = ty.matrix;
    out.push({ name, offset, scalar: m.scalar, width: 1, matrix: { rows: m.rows, columns: m.columns, major: m.major, stride: m.stride } });
  } else if ('array' in ty) {
    // the first 16 elements as fields of their own
    for (let i = 0; i < Math.min(ty.array.count, 16); i++) flatten(`${name}[${i}]`, offset + i * ty.array.stride, ty.array.element, out);
  } else if ('struct' in ty) {
    for (const m of ty.struct.members) flatten(`${name}.${m.name}`, offset + m.offset, m.ty, out);
  }
}

const matrixRole = (name: string): MatrixRole | null => {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (/(worldviewproj|wvp|mvp|modelviewproj)/.test(n)) return 'world-view-projection';
  if (/(viewproj|vp$)/.test(n)) return 'view-projection';
  if (/(worldview|modelview)/.test(n)) return 'world-view';
  if (/(proj)/.test(n)) return 'projection';
  if (/(view)/.test(n)) return 'view';
  if (/(world|model|object)/.test(n)) return 'world';
  return null;
};

function role(f: Omit<Field, 'role' | 'read'>, lines: MatrixLines | null): Role | null {
  const n = f.name.toLowerCase().replace(/^(g_|u_|i)/, '');
  if (f.matrix) {
    const which = matrixRole(f.name);
    return which ? { kind: 'matrix', which, lines } : null;
  }
  if (f.scalar !== 'float') return null;
  if (f.width === 1 && /^(time|seconds|elapsed|globaltime)$/.test(n)) return { kind: 'time' };
  if (f.width >= 2 && /mouse/.test(n)) return { kind: 'mouse' };
  if (f.width >= 2 && /^(resolution|screensize|viewport(size)?)$/.test(n)) return { kind: 'resolution' };
  if (f.width === 2 && /texelsize/.test(n)) return { kind: 'texel-size' };
  if (f.width >= 3 && /^(eye|camera|view)(pos(ition)?)?(ws|world)?$/.test(n)) return { kind: 'eye' };
  return null;
}

/** The page's buffers for `iface`: each constant buffer's words, from the program's defaults, then `presets`. */
export function buffers(iface: Interface, analyses: Analyses | undefined, presets: Record<string, number[]> = {}): Buffer[] {
  const out: Buffer[] = [];
  for (const r of iface.resources) {
    if (typeof r.kind !== 'object' || !('constant_buffer' in r.kind)) continue;
    const layout = r.kind.constant_buffer.layout;
    const size = Math.max(16, Math.ceil(layout.size / 16) * 16);
    const words = new Uint32Array(size / 4);
    const read = analyses?.constants_read.find(([id]) => id === r.id)?.[1];
    const fields: Field[] = [];
    for (const c of layout.constants) {
      if (c.default) {
        const bytes = new Uint8Array(c.default);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i + 4 <= bytes.length; i += 4) {
          const at = (c.offset + i) / 4;
          if (at < words.length) words[at] = view.getUint32(i, true);
        }
      }
      const flat: Omit<Field, 'role' | 'read'>[] = [];
      flatten(c.name, c.offset, c.ty, flat);
      for (const f of flat) {
        const lines = analyses?.matrices.find((m) => m.resource === r.id && m.offset === f.offset)?.lines ?? null;
        const span = f.matrix ? matrixBytes(f.matrix) : f.width * 4;
        fields.push({
          ...f,
          role: role(f, lines),
          read: read ? read.some((o) => o >= f.offset && o < f.offset + span) : null,
        });
      }
    }
    const buffer: Buffer = { resource: r.id, name: r.provenance.name, register: r.provenance.d3d?.register ?? null, words, fields };
    for (const f of fields) {
      const preset = presets[f.name];
      if (preset && !f.matrix) setLanes(buffer, f, preset);
    }
    out.push(buffer);
  }
  return out;
}

function matrixBytes(m: NonNullable<Field['matrix']>): number {
  const lines = m.major === 'row' ? m.rows : m.columns;
  const lanes = m.major === 'row' ? m.columns : m.rows;
  return (lines - 1) * m.stride + lanes * 4;
}

export function getLanes(b: Buffer, f: Field): number[] {
  const out: number[] = [];
  for (let i = 0; i < f.width; i++) out.push(lane(f.scalar, b.words[f.offset / 4 + i] ?? 0));
  return out;
}

export function setLanes(b: Buffer, f: Field, values: number[]): void {
  for (let i = 0; i < f.width && i < values.length; i++) {
    const at = f.offset / 4 + i;
    if (at < b.words.length) b.words[at] = word(f.scalar, values[i]);
  }
}

/**
 * Write `m` (4 x 4, row-major in `m[row * 4 + column]`, applied to column vectors) into a matrix field as the program
 * reads it: each stored line a row of `m` where the analysis shows the program's lines are rows, a column where it
 * shows columns. Where the program does not show which, lines are written as rows (what `mul(v, M)` with HLSL's
 * default packing reads), and `false` is returned so the page can say so.
 */
export function setMatrix(b: Buffer, f: Field, m: Float32Array): boolean {
  const mat = f.matrix;
  if (!mat) return false;
  const lines = mat.major === 'row' ? mat.rows : mat.columns;
  const lanes = mat.major === 'row' ? mat.columns : mat.rows;
  const lr = f.role?.kind === 'matrix' ? f.role.lines : null;
  const rows = lr !== 'columns';
  for (let line = 0; line < lines; line++) {
    for (let k = 0; k < lanes; k++) {
      const value = rows ? m[line * 4 + k] : m[k * 4 + line];
      const at = (f.offset + line * mat.stride) / 4 + k;
      if (at < b.words.length) b.words[at] = floatBits(value ?? 0);
    }
  }
  return lr === 'rows' || lr === 'columns';
}

/** The constant buffers' words as `Request.buffers` and as pins of `fields`. */
export const requestBuffers = (bs: Buffer[]): [number, number[]][] => bs.map((b) => [b.resource, Array.from(b.words)]);

export function pinWords(b: Buffer, f: Field): [number, number, number][] {
  const out: [number, number, number][] = [];
  const span = f.matrix ? matrixBytes(f.matrix) : f.width * 4;
  for (let o = f.offset; o < f.offset + span; o += 4) out.push([b.resource, o, b.words[o / 4] ?? 0]);
  return out;
}

export const textureRegister = (r: Resource): number | null => r.provenance.d3d?.register ?? null;

// The placeholder textures, drawn here (no image files): each 256 x 256 RGBA8, rows top to bottom.
import type { TextureKind } from '../examples';

export interface Pixels {
  width: number;
  height: number;
  texels: Uint8Array<ArrayBuffer>;
  /** rgba8snorm rather than rgba8unorm. */
  signed: boolean;
  label: string;
}

const N = 256;

function draw(label: string, f: (x: number, y: number) => [number, number, number, number], signed = false): Pixels {
  const texels = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const c = f((x + 0.5) / N, (y + 0.5) / N);
      for (let k = 0; k < 4; k++) {
        const v = Math.max(signed ? -1 : 0, Math.min(1, c[k]));
        texels[(y * N + x) * 4 + k] = signed ? Math.round(v * 127) & 0xff : Math.round(v * 255);
      }
    }
  return { width: N, height: N, texels, signed, label };
}

// a repeatable value noise
const hash = (x: number, y: number): number => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function noise(x: number, y: number, period: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const w = (t: number) => t * t * (3 - 2 * t);
  const h = (a: number, b: number) => hash(((a % period) + period) % period, ((b % period) + period) % period);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * w(fx) + (c - a) * w(fy) + (a - b - c + d) * w(fx) * w(fy);
}
const fbm = (x: number, y: number, period: number): number => {
  let s = 0;
  let a = 0.5;
  for (let o = 0; o < 4; o++) {
    s += a * noise(x * (1 << o), y * (1 << o), period * (1 << o));
    a *= 0.5;
  }
  return s;
};

/** Brick height (0 in mortar, 1 on a brick) at uv. */
function brickHeight(u: number, v: number): number {
  const rows = 8;
  const cols = 4;
  const y = v * rows;
  const row = Math.floor(y);
  const x = u * cols + (row % 2 ? 0.5 : 0);
  const fx = x - Math.floor(x);
  const fy = y - row;
  const m = 0.06;
  const edge = Math.min(fx, 1 - fx, (fy * cols) / rows, ((1 - fy) * cols) / rows);
  return Math.min(1, Math.max(0, (edge - m * 0.5) / m));
}

const makers: Record<TextureKind, () => Pixels> = {
  checker: () =>
    draw('checker', (u, v) => {
      const c = (Math.floor(u * 8) + Math.floor(v * 8)) % 2 ? 0.85 : 0.25;
      return [c, c, c, 1];
    }),
  grid: () =>
    draw('grid', (u, v) => {
      const line = Math.min(Math.abs(((u * 8) % 1) - 0.5), Math.abs(((v * 8) % 1) - 0.5)) > 0.46;
      return line ? [0.15, 0.15, 0.18, 1] : [0.9, 0.88, 0.84, 1];
    }),
  brick: () =>
    draw('brick', (u, v) => {
      const hgt = brickHeight(u, v);
      const n = fbm(u * 16, v * 16, 16);
      const row = Math.floor(v * 8);
      const tone = 0.85 + 0.3 * hash(Math.floor(u * 4 + (row % 2 ? 0.5 : 0)), row);
      const brick = [0.62 * tone, 0.28 * tone, 0.2 * tone];
      const mortar = [0.72, 0.7, 0.66];
      return [0, 1, 2].map((k) => (mortar[k] + (brick[k] - mortar[k]) * hgt) * (0.85 + 0.3 * n)).concat(1) as [number, number, number, number];
    }),
  'brick-normal': () =>
    draw('brick normal map', (u, v) => {
      const e = 1 / N;
      const s = 3;
      const hx = (brickHeight(u + e, v) - brickHeight(u - e, v)) * s + (fbm((u + e) * 32, v * 32, 32) - fbm((u - e) * 32, v * 32, 32)) * 0.6;
      const hy = (brickHeight(u, v + e) - brickHeight(u, v - e)) * s + (fbm(u * 32, (v + e) * 32, 32) - fbm(u * 32, (v - e) * 32, 32)) * 0.6;
      const n = [-hx, hy, 1];
      const l = Math.hypot(n[0], n[1], n[2]);
      return [n[0] / l / 2 + 0.5, n[1] / l / 2 + 0.5, n[2] / l / 2 + 0.5, 1];
    }),
  marble: () =>
    draw('marble', (u, v) => {
      const t = Math.sin((u + fbm(u * 6, v * 6, 6) * 1.6) * Math.PI * 6) * 0.5 + 0.5;
      return [0.55 + 0.4 * t, 0.5 + 0.38 * t, 0.46 + 0.3 * t, 1];
    }),
  scene: () =>
    draw('landscape', (u, v) => {
      const horizon = 0.55 + 0.08 * (fbm(u * 4, 0.5, 4) - 0.5);
      if (v < horizon) {
        const sun = Math.exp(-((u - 0.7) ** 2 + (v - 0.25) ** 2) * 60);
        const cloud = Math.max(0, fbm(u * 6, v * 12, 6) - 0.5) * 1.6;
        return [0.35 + 0.6 * sun + cloud, 0.55 + 0.4 * sun + cloud, 0.85 + 0.1 * sun + cloud, 1];
      }
      const g = fbm(u * 24, v * 24, 24);
      return [0.2 + 0.25 * g, 0.4 + 0.25 * g, 0.15 + 0.1 * g, 1];
    }),
  'hdr-scene': () =>
    draw('night street', (u, v) => {
      let c = [0.04, 0.05, 0.09];
      for (let i = 0; i < 7; i++) {
        const lx = 0.08 + i * 0.14;
        const ly = 0.35 + 0.1 * Math.sin(i * 1.7);
        const d = (u - lx) ** 2 + (v - ly) ** 2;
        const glow = Math.exp(-d * 900);
        const hue = [1, 0.7 + 0.3 * Math.sin(i), 0.4 + 0.4 * Math.cos(i * 2)];
        c = c.map((x, k) => x + glow * hue[k]);
      }
      if (v > 0.7) c = c.map((x) => x + 0.05 * fbm(u * 30, v * 30, 30));
      return [c[0], c[1], c[2], 1];
    }),
  ripple: () =>
    draw(
      'ripple bump map (du, dv signed)',
      (u, v) => {
        const e = 1 / 64;
        const height = (x: number, y: number) => fbm(x * 8, y * 8, 8) + 0.5 * Math.sin((x + y) * Math.PI * 16);
        const du = (height(u + e, v) - height(u - e, v)) * 2;
        const dv = (height(u, v + e) - height(u, v - e)) * 2;
        return [du, dv, 0, 1];
      },
      true,
    ),
};

const cache = new Map<string, Pixels>();
export function placeholder(kind: TextureKind): Pixels {
  let p = cache.get(kind);
  if (!p) {
    p = makers[kind]();
    cache.set(kind, p);
  }
  return p;
}

/** A dropped image as RGBA8 pixels, scaled to at most 1024 on its long side. */
export async function fromFile(file: File): Promise<Pixels> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser gives no 2D canvas to read the image with');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  return { width, height, texels: new Uint8Array(data.buffer.slice(0)), signed: false, label: file.name };
}

/** The texture a register gets by its name when the example names none. */
export function guess(name: string): TextureKind {
  const n = name.toLowerCase();
  if (/normal|bump/.test(n)) return 'brick-normal';
  if (/image|scene|source|input|frame|hdr|screen/.test(n)) return 'scene';
  if (/albedo|diffuse|base|color|colour|tex/.test(n)) return 'brick';
  return 'checker';
}

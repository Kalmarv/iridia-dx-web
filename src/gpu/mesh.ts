// The preview's meshes, each with positions, normals, tangents (xyz and handedness), texture coordinates and colours,
// triangle indices and the edges for the wireframe. The torus knot is the detailed model: ours, generated here.
import type { MeshName } from '../examples';

export interface Mesh {
  name: string;
  position: Float32Array<ArrayBuffer>;
  normal: Float32Array<ArrayBuffer>;
  tangent: Float32Array<ArrayBuffer>;
  uv: Float32Array<ArrayBuffer>;
  color: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  edges: Uint32Array<ArrayBuffer>;
  count: number;
}

type V = { p: number[]; n: number[]; t: number[]; uv: number[] };

function build(name: string, vs: V[], tris: number[]): Mesh {
  const count = vs.length;
  const mesh: Mesh = {
    name,
    position: new Float32Array(count * 3),
    normal: new Float32Array(count * 3),
    tangent: new Float32Array(count * 4),
    uv: new Float32Array(count * 2),
    color: new Float32Array(count * 4),
    indices: new Uint32Array(tris),
    edges: new Uint32Array(0),
    count,
  };
  vs.forEach((v, i) => {
    mesh.position.set(v.p, i * 3);
    mesh.normal.set(v.n, i * 3);
    mesh.tangent.set([...v.t.slice(0, 3), v.t[3] ?? 1], i * 4);
    mesh.uv.set(v.uv, i * 2);
    // a soft colour from the normal: something for a COLOR input to show
    mesh.color.set([0.6 + 0.4 * v.n[0], 0.6 + 0.4 * v.n[1], 0.6 + 0.4 * v.n[2], 1], i * 4);
  });
  const seen = new Set<string>();
  const edges: number[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    for (const [a, b] of [
      [tris[i], tris[i + 1]],
      [tris[i + 1], tris[i + 2]],
      [tris[i + 2], tris[i]],
    ]) {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(a, b);
      }
    }
  }
  mesh.edges = new Uint32Array(edges);
  return mesh;
}

/** A grid over (u, v) in [0, 1]^2 of `f`, which gives each point's position, normal and tangent. */
function surface(name: string, nu: number, nv: number, f: (u: number, v: number) => V): Mesh {
  const vs: V[] = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) vs.push(f(i / nu, j / nv));
  const tris: number[] = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const b = a + 1;
      const c = a + nu + 1;
      const d = c + 1;
      tris.push(a, c, b, b, c, d);
    }
  return build(name, vs, tris);
}

const norm = (a: number[]): number[] => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const crossv = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function plane(): Mesh {
  return surface('plane', 1, 1, (u, v) => ({ p: [u * 2 - 1, 0, v * 2 - 1], n: [0, 1, 0], t: [1, 0, 0, 1], uv: [u, v] }));
}

export function cube(): Mesh {
  const vs: V[] = [];
  const tris: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, t, b] of faces) {
    const base = vs.length;
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const x = u * 2 - 1;
      const y = v * 2 - 1;
      vs.push({
        p: [0.8 * (n[0] + t[0] * x + b[0] * y), 0.8 * (n[1] + t[1] * x + b[1] * y), 0.8 * (n[2] + t[2] * x + b[2] * y)],
        n,
        t: [...t, 1],
        uv: [u, 1 - v],
      });
    }
    tris.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  return build('cube', vs, tris);
}

export function sphere(): Mesh {
  return surface('sphere', 64, 32, (u, v) => {
    const phi = u * Math.PI * 2;
    const theta = v * Math.PI;
    const n = [Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi)];
    return { p: n.map((x) => x * 1.1), n, t: [Math.cos(phi), 0, -Math.sin(phi), 1], uv: [u, v] };
  });
}

export function torus(): Mesh {
  const R = 0.9;
  const r = 0.38;
  return surface('torus', 96, 32, (u, v) => {
    const a = u * Math.PI * 2;
    const b = v * Math.PI * 2;
    const n = [Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)];
    const p = [(R + r * Math.cos(b)) * Math.cos(a), r * Math.sin(b), (R + r * Math.cos(b)) * Math.sin(a)];
    return { p, n, t: [-Math.sin(a), 0, Math.cos(a), 1], uv: [u * 3, v] };
  });
}

/** A (3, 2) torus knot tube, 384 by 24 segments: the detailed model. */
export function knot(): Mesh {
  const P = 3;
  const Q = 2;
  const curve = (s: number): number[] => {
    const phi = s * Math.PI * 2;
    const r = 0.62 + 0.28 * Math.cos(Q * phi);
    return [r * Math.cos(P * phi), 0.28 * Math.sin(Q * phi) * 1.4, r * Math.sin(P * phi)];
  };
  const tube = 0.17;
  return surface('knot', 384, 24, (u, v) => {
    const c = curve(u);
    const ahead = curve(u + 1e-4);
    const t = norm([ahead[0] - c[0], ahead[1] - c[1], ahead[2] - c[2]]);
    const side = norm(crossv(t, [0, 1, 0]));
    const up = crossv(side, t);
    const a = v * Math.PI * 2;
    const n = norm([side[0] * Math.cos(a) + up[0] * Math.sin(a), side[1] * Math.cos(a) + up[1] * Math.sin(a), side[2] * Math.cos(a) + up[2] * Math.sin(a)]);
    return { p: [c[0] + n[0] * tube, c[1] + n[1] * tube, c[2] + n[2] * tube], n, t: [...t, 1], uv: [u * 12, v] };
  });
}

/** The quad the preview draws a pixel program on: clip space, texture coordinates down from the top left. */
export function screen(): Mesh {
  return surface('screen', 1, 1, (u, v) => ({ p: [u * 2 - 1, 1 - v * 2, 0], n: [0, 0, 1], t: [1, 0, 0, 1], uv: [u, v] }));
}

const makers: Record<MeshName, () => Mesh> = { plane, cube, sphere, torus, knot };
const cache = new Map<string, Mesh>();
export function mesh(name: MeshName | 'screen'): Mesh {
  let m = cache.get(name);
  if (!m) {
    m = name === 'screen' ? screen() : makers[name]();
    cache.set(name, m);
  }
  return m;
}
export const MESHES: MeshName[] = ['plane', 'cube', 'sphere', 'torus', 'knot'];

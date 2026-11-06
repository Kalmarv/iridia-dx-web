// What the preview reads from a program's WGSL (its resource declarations, workgroup size) and the WGSL it writes
// around one: the vertex program that feeds a pixel program from a mesh, the pixel program that shows a vertex
// program's outputs, the capture programs that read back what a pixel program received, and the blit to the canvas.
import type { Io, Scalar } from '../types';

export type DeclKind =
  | { kind: 'uniform'; size: number }
  | { kind: 'storage-buffer'; access: 'read' | 'read_write'; size: number }
  | { kind: 'texture'; view: GPUTextureViewDimension; sample: GPUTextureSampleType; multisampled: boolean }
  | { kind: 'storage-texture'; view: GPUTextureViewDimension; format: GPUTextureFormat; access: GPUStorageTextureAccess }
  | { kind: 'sampler'; comparison: boolean };

export interface Decl {
  group: number;
  binding: number;
  name: string;
  type: string;
  what: DeclKind | { kind: 'unknown' };
}

const VIEW: Record<string, GPUTextureViewDimension> = {
  '1d': '1d',
  '2d': '2d',
  '2d_array': '2d-array',
  '3d': '3d',
  cube: 'cube',
  cube_array: 'cube-array',
};

/** The byte size of a WGSL type naga writes for a buffer: `array<vec4<u32>, N>`, a scalar, vector or matrix. */
function sizeOf(type: string): number {
  const array = type.match(/^array<(.+),\s*(\d+)>$/);
  if (array) return sizeOf(array[1]) * Number(array[2]);
  const vec = type.match(/^vec([234])<\w+>$/);
  if (vec) return Number(vec[1]) === 3 ? 16 : Number(vec[1]) * 4;
  const mat = type.match(/^mat([234])x([234])<f32>$/);
  if (mat) return Number(mat[1]) * (Number(mat[2]) === 2 ? 8 : 16);
  if (/^(f32|u32|i32)$/.test(type)) return 4;
  return 0;
}

/** Each `@group(g) @binding(b) var...;` of `text`. */
export function declarations(text: string): Decl[] {
  const out: Decl[] = [];
  const re = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+(\w+)\s*:\s*([^;]+);/g;
  for (const m of text.matchAll(re)) {
    const [, g, b, space, name, rawType] = m;
    const type = rawType.trim();
    let what: Decl['what'] = { kind: 'unknown' };
    const tex = type.match(/^texture_(multisampled_)?(depth_)?(1d|2d_array|2d|3d|cube_array|cube)(?:<(\w+)>)?$/);
    const storage = type.match(/^texture_storage_(1d|2d_array|2d|3d)<(\w+),\s*(\w+)>$/);
    if (space?.startsWith('uniform')) what = { kind: 'uniform', size: sizeOf(type) };
    else if (space?.startsWith('storage'))
      what = { kind: 'storage-buffer', access: space.includes('read_write') ? 'read_write' : 'read', size: sizeOf(type) };
    else if (type === 'sampler' || type === 'sampler_comparison') what = { kind: 'sampler', comparison: type !== 'sampler' };
    else if (storage)
      what = {
        kind: 'storage-texture',
        view: VIEW[storage[1]],
        format: storage[2] as GPUTextureFormat,
        access: storage[3] === 'write' ? 'write-only' : storage[3] === 'read' ? 'read-only' : 'read-write',
      };
    else if (tex)
      what = {
        kind: 'texture',
        view: VIEW[tex[3]],
        multisampled: !!tex[1],
        sample: tex[2] ? 'depth' : tex[4] === 'u32' ? 'uint' : tex[4] === 'i32' ? 'sint' : 'float',
      };
    out.push({ group: Number(g), binding: Number(b), name, type, what });
  }
  return out;
}

/** The entry point's stage and, for a compute program, its workgroup size. */
export function entry(text: string): { stage: 'vertex' | 'fragment' | 'compute' | null; workgroup: [number, number, number] } {
  const c = text.match(/@compute\s*@workgroup_size\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?\)/);
  if (c) return { stage: 'compute', workgroup: [Number(c[1]), Number(c[2] ?? 1), Number(c[3] ?? 1)] };
  if (/@fragment/.test(text)) return { stage: 'fragment', workgroup: [1, 1, 1] };
  if (/@vertex/.test(text)) return { stage: 'vertex', workgroup: [1, 1, 1] };
  return { stage: null, workgroup: [1, 1, 1] };
}

const SCALAR: Record<Scalar, string> = { float: 'f32', uint: 'u32', sint: 'i32', bool: 'u32', double: 'f32' };
export const wgslType = (s: Scalar, width: number): string => (width === 1 ? SCALAR[s] : `vec${width}<${SCALAR[s]}>`);

const BUILTIN_TYPE: Record<string, string> = {
  position: 'vec4<f32>',
  front_facing: 'bool',
  sample_index: 'u32',
  sample_mask: 'u32',
  vertex_index: 'u32',
  instance_index: 'u32',
  frag_depth: 'f32',
  global_invocation_id: 'vec3<u32>',
};

/** `@location(n) @interpolate(...)` as the program declares the varying. */
export function locationAttrs(io: Io): string {
  let s = `@location(${io.location})`;
  if (io.interpolation) s += ` @interpolate(${io.interpolation}${io.sampling ? `, ${io.sampling}` : ''})`;
  else if (io.scalar !== 'float') s += ' @interpolate(flat)';
  return s;
}

/** A varying or built-in argument as the program declares it. */
export function argument(io: Io, name: string): string {
  if (io.builtin) return `@builtin(${io.builtin}) ${name}: ${BUILTIN_TYPE[io.builtin] ?? 'vec4<f32>'}`;
  return `${locationAttrs(io)} ${name}: ${wgslType(io.scalar, io.width)}`;
}

/** What of the mesh feeds a pixel program's input. */
export type Feed = 'uv' | 'world' | 'normal' | 'tangent' | 'color' | 'clip' | 'screen' | 'zero';
export const FEEDS: Feed[] = ['uv', 'world', 'normal', 'tangent', 'color', 'screen', 'clip', 'zero'];

/** The feed an input gets by its semantic (`TEXCOORD0`, `NORMAL`, `POSITION1`). */
export function defaultFeed(semantic: string, index: number): Feed {
  const s = semantic.toUpperCase();
  if (s === 'POSITION' || s === 'SV_POSITION' || s === 'WORLDPOS') return index === 0 && s !== 'POSITION' ? 'clip' : 'world';
  if (s === 'NORMAL') return 'normal';
  if (s === 'TANGENT') return 'tangent';
  if (s === 'COLOR') return 'color';
  return 'uv';
}

const FEED_EXPR: Record<Feed, string> = {
  uv: 'vec4<f32>(v.uv, 0.0, 1.0)',
  world: 'vec4<f32>(world.xyz, 1.0)',
  normal: 'vec4<f32>(n, 0.0)',
  tangent: 't',
  color: 'v.color',
  clip: 'clip',
  screen: 'vec4<f32>(clip.xy / clip.w * vec2<f32>(0.5, -0.5) + 0.5, 0.0, 1.0)',
  zero: 'vec4<f32>(0.0)',
};

/** `value` (a `vec4<f32>` expression) as a value of the varying's type. */
function convert(value: string, s: Scalar, width: number): string {
  const lanes = ['x', 'xy', 'xyz', 'xyzw'][width - 1];
  const part = width === 4 ? value : `(${value}).${lanes}`;
  if (s === 'float' || s === 'double') return part;
  return `${wgslType(s, width)}(${part})`;
}

/** The page's camera, as the generated vertex program reads it. */
export const CAMERA_STRUCT = `struct PageCamera {
    world: mat4x4<f32>,
    view_projection: mat4x4<f32>,
    normal_matrix: mat4x4<f32>,
}`;
export const CAMERA_SIZE = 3 * 64;

/** The mesh's vertex attributes as the generated vertex program reads them. */
export const MESH_ATTRIBUTES = ['position', 'normal', 'tangent', 'uv', 'color'] as const;
export const MESH_FORMATS: GPUVertexFormat[] = ['float32x3', 'float32x3', 'float32x4', 'float32x2', 'float32x4'];

/** A vertex program feeding `inputs` (a pixel program's varyings) from the mesh, its camera at `group`/`binding`. */
export function feederVertex(inputs: Io[], feeds: Feed[], group: number, binding: number): string {
  const members = inputs.filter((i) => i.location !== null).map((io) => `    ${locationAttrs(io)} f${io.location}: ${wgslType(io.scalar, io.width)},`);
  const writes = inputs
    .map((io, k) => (io.location === null ? '' : `    o.f${io.location} = ${convert(FEED_EXPR[feeds[k] ?? 'uv'], io.scalar, io.width)};`))
    .filter(Boolean);
  return `${CAMERA_STRUCT}
@group(${group}) @binding(${binding}) var<uniform> page: PageCamera;

struct MeshVertex {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) color: vec4<f32>,
}

struct Fed {
    @builtin(position) clip: vec4<f32>,
${members.join('\n')}
}

@vertex
fn main(v: MeshVertex) -> Fed {
    let world = page.world * vec4<f32>(v.position, 1.0);
    let clip = page.view_projection * world;
    let n = normalize((page.normal_matrix * vec4<f32>(v.normal, 0.0)).xyz);
    let t = vec4<f32>(normalize((page.world * vec4<f32>(v.tangent.xyz, 0.0)).xyz), v.tangent.w);
    var o: Fed;
    o.clip = clip;
${writes.join('\n')}
    return o;
}
`;
}

/** A pixel program showing output `shown` of a vertex program whose outputs are `outputs`, as a colour. */
export function showOutput(outputs: Io[], shown: number | null): string {
  const args = outputs.filter((o) => o.location !== null).map((o) => argument(o, `o${o.location}`));
  const chosen = outputs.find((o) => o.location === shown);
  let colour = 'vec4<f32>(0.8, 0.8, 0.8, 1.0)';
  if (chosen) {
    const name = `o${chosen.location}`;
    const f = chosen.scalar === 'float' ? name : `${wgslType('float', chosen.width)}(${name})`;
    colour = [
      `vec4<f32>(${f}, ${f}, ${f}, 1.0)`,
      `vec4<f32>(${f}, 0.0, 1.0)`,
      `vec4<f32>(${f}, 1.0)`,
      `vec4<f32>(${f}.xyz, 1.0)`,
    ][chosen.width - 1];
  }
  return `@fragment
fn main(${args.join(', ')}) -> @location(0) vec4<f32> {
    return ${colour};
}
`;
}

/** A pixel program that writes what argument `k` of `inputs` received, as its bits, to an `rgba32uint` target. */
export function captureInput(inputs: Io[], k: number): string {
  const args = inputs.map((io, i) => argument(io, `a${i}`));
  const io = inputs[k];
  const name = `a${k}`;
  let bits: string;
  if (io.builtin === 'front_facing') bits = io.scalar === 'float' ? `vec4<u32>(bitcast<u32>(select(-1.0, 1.0, ${name})), 0u, 0u, 0u)` : `vec4<u32>(select(0u, 0xffffffffu, ${name}), 0u, 0u, 0u)`;
  else if (io.builtin === 'sample_index' || io.builtin === 'sample_mask') bits = `vec4<u32>(${name}, 0u, 0u, 0u)`;
  else if (io.builtin === 'position') bits = `bitcast<vec4<u32>>(${name})`;
  else {
    const w = io.width;
    const as = io.scalar === 'float' ? (w === 1 ? `bitcast<u32>(${name})` : `bitcast<vec${w}<u32>>(${name})`) : w === 1 ? `u32(${name})` : `vec${w}<u32>(${name})`;
    bits = w === 4 ? as : `vec4<u32>(${as}${', 0u'.repeat(4 - w)})`;
  }
  return `@fragment
fn main(${args.join(', ')}) -> @location(0) vec4<u32> {
    return ${bits};
}
`;
}

/** A pixel program whose output is constant: the wireframe's lines. */
export const FLAT_COLOUR = `@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(0.05, 0.9, 0.75, 1.0);
}
`;

/**
 * The blit to the canvas: a full-screen triangle reading `src` texel for texel (or fitted, for a compute program's
 * image), clamped to [0, 1] for an 8-bit canvas. `sample` is the source's type: float, uint (shown / 255) or sint.
 */
export function blit(sample: 'float' | 'uint' | 'sint'): string {
  const t = sample === 'float' ? 'f32' : sample === 'uint' ? 'u32' : 'i32';
  const read = sample === 'float' ? 'c' : 'vec4<f32>(c) / 255.0';
  return `struct Fit { offset: vec2<f32>, scale: vec2<f32>, background: vec4<f32> }
@group(0) @binding(0) var src: texture_2d<${t}>;
@group(0) @binding(1) var<uniform> fit: Fit;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(src));
    let uv = (at.xy - fit.offset) * fit.scale;
    if (any(uv < vec2<f32>(0.0)) || any(uv >= size)) {
        return fit.background;
    }
    let c = textureLoad(src, vec2<i32>(uv), 0);
    return vec4<f32>(clamp((${read}).rgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;
}

// The page's examples: our own HLSL (or assembly), compiled by fxc, dxc or D3DAssemble (web/examples/build.sh). Each
// names how the preview draws it and the textures, presets and pipeline state the page binds.

export type View = 'quad' | 'mesh' | 'compute' | 'none';
export type MeshName = 'plane' | 'cube' | 'sphere' | 'torus' | 'knot';
export type TextureKind = 'checker' | 'brick' | 'brick-normal' | 'scene' | 'hdr-scene' | 'ripple' | 'marble' | 'grid';

export interface Example {
  id: string;
  title: string;
  /** One plain line: what the program does and what of iridia it shows. */
  summary: string;
  /** The compiled program (a pixel or compute program, or a vertex program when `pixel` is set). */
  program: string;
  /** A pair: the vertex program is `program`, this the pixel program it feeds. */
  pixel?: string;
  sources: { name: string; path: string }[];
  view: View;
  mesh?: MeshName;
  /** Each texture register's image; `signed` for an rgba8snorm bump map. */
  textures?: Record<number, { kind: TextureKind; signed?: boolean }>;
  /** Constants the page sets where the program states no default (DXIL keeps none): name to lanes. */
  presets?: Record<string, number[]>;
  /** Pipeline state the page sets, as the application would: the state's kind, its stage, its lanes. */
  state?: { param: string; stage: number; lanes: number[] }[];
}

export const EXAMPLES: Example[] = [
  {
    id: 'plasma',
    title: 'Plasma',
    summary: 'ps_5_0 (DXBC): sums of sines through a palette, its constant buffer driven by time.',
    program: 'plasma/plasma.dxbc',
    sources: [{ name: 'plasma.hlsl', path: 'plasma/plasma.hlsl' }],
    view: 'quad',
  },
  {
    id: 'lit-brick',
    title: 'Normal-mapped brick',
    summary: 'ps_5_0 (DXBC): Blinn-Phong with two uint feature switches to pin and fold.',
    program: 'lit-brick/lit-brick.dxbc',
    sources: [{ name: 'lit-brick.hlsl', path: 'lit-brick/lit-brick.hlsl' }],
    view: 'mesh',
    mesh: 'cube',
    textures: { 0: { kind: 'brick' }, 1: { kind: 'brick-normal' } },
  },
  {
    id: 'd3d9-pair',
    title: 'Direct3D 9 vertex + pixel pair',
    summary: 'vs_3_0 + ps_3_0 on the IR: the vertex program lights the mesh, linked to the pixel program by semantic.',
    program: 'd3d9-pair/d3d9-pair.vso',
    pixel: 'd3d9-pair/d3d9-pair.pso',
    sources: [
      { name: 'd3d9-pair.vs.hlsl', path: 'd3d9-pair/d3d9-pair.vs.hlsl' },
      { name: 'd3d9-pair.ps.hlsl', path: 'd3d9-pair/d3d9-pair.ps.hlsl' },
    ],
    view: 'mesh',
    mesh: 'knot',
    textures: { 0: { kind: 'marble' } },
  },
  {
    id: 'toon',
    title: 'Toon bands (ps_2_0)',
    summary: 'ps_2_0 on the IR: posterised bands and an outline from four taps.',
    program: 'd3d9-ps2/toon.pso',
    sources: [{ name: 'toon.hlsl', path: 'd3d9-ps2/toon.hlsl' }],
    view: 'quad',
    textures: { 0: { kind: 'scene' } },
  },
  {
    id: 'water',
    title: 'Bump-mapped water (ps_1_1)',
    summary: 'ps_1_1 assembly on the IR: texbem reads the bump matrix, pipeline state the page specialises.',
    program: 'd3d9-ps1/water.pso',
    sources: [{ name: 'water.asm', path: 'd3d9-ps1/water.asm' }],
    view: 'quad',
    textures: { 0: { kind: 'ripple', signed: true }, 1: { kind: 'scene' } },
    state: [{ param: 'bump_env_mat', stage: 1, lanes: [0.04, 0, 0, 0.04] }],
  },
  {
    id: 'bloom',
    title: 'Bloom and tonemap',
    summary: 'ps_5_0 (DXBC): a 13-tap bright-pass, ACES tonemapping, vignette and aberration over an image.',
    program: 'post/bloom-tonemap.dxbc',
    sources: [{ name: 'bloom-tonemap.hlsl', path: 'post/bloom-tonemap.hlsl' }],
    view: 'quad',
    textures: { 0: { kind: 'hdr-scene' } },
  },
  {
    id: 'raymarch',
    title: 'Sphere tracing (DXIL)',
    summary: 'ps_6_0 (DXIL): a loop with an early exit, soft shadows and occlusion; drag to orbit.',
    program: 'sdf-dxil/raymarch.dxil',
    sources: [{ name: 'raymarch.hlsl', path: 'sdf-dxil/raymarch.hlsl' }],
    view: 'quad',
    presets: {
      twist: [1.2],
      shadowSoftness: [12],
      maxSteps: [96],
      baseColor: [0.9, 0.55, 0.3],
      fieldOfView: [1.1],
      mouse: [0.5, 0.5],
    },
  },
  {
    id: 'julia',
    title: 'Julia set (compute)',
    summary: 'cs_5_0 (DXBC): one thread per texel, written to a storage texture.',
    program: 'compute-fractal/julia.dxbc',
    sources: [{ name: 'julia.hlsl', path: 'compute-fractal/julia.hlsl' }],
    view: 'compute',
  },
  {
    id: 'pbr',
    title: 'GGX material (DXIL)',
    summary: 'ps_6_0 (DXIL): GGX, Smith and Schlick with two lights, on a sphere.',
    program: 'pbr-dxil/pbr.dxil',
    sources: [{ name: 'pbr.hlsl', path: 'pbr-dxil/pbr.hlsl' }],
    view: 'mesh',
    mesh: 'sphere',
    textures: { 0: { kind: 'grid' } },
    presets: {
      baseColor: [0.95, 0.64, 0.54],
      roughness: [0.35],
      metalness: [1],
      keyLightDirection: [0.5, 0.8, 0.3],
      keyLightIntensity: [3],
      keyLightColor: [1, 0.96, 0.9],
      fillLightIntensity: [0.6],
      skyColor: [0.4, 0.5, 0.7],
      exposure: [1],
    },
  },
  {
    id: 'amplification',
    title: 'Amplification program (refused)',
    summary: 'as_6_5 (DXIL): iridia does not lift amplification programs, and says so.',
    program: 'amplification/amplification.dxil',
    sources: [{ name: 'amplification.hlsl', path: 'amplification/amplification.hlsl' }],
    view: 'none',
  },
];

export const byId = (id: string): Example | undefined => EXAMPLES.find((e) => e.id === id);

export const exampleUrl = (path: string): string => `./examples/${path}`;

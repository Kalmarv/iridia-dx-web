// The live preview: a program's WGSL drawn with WebGPU. A pixel program is fed from a mesh (or the screen quad) by a
// vertex program the page writes; a vertex program draws the mesh itself, into the pixel program it is linked to or
// one that shows an output; a compute program writes a storage texture the page shows. Every bind group layout is
// explicit, made from the declarations the WGSL states, and every resource is found by the program's own bindings.
import type { Binding, Io, Scalar } from '../types';
import type { Mesh } from './mesh';
import * as W from './wgsl';

/** One program of the scene: its WGSL, bindings and entry point, and what binds each of its resources. */
export interface Program {
  key: 'vertex' | 'pixel' | 'compute';
  text: string;
  bindings: Binding[];
  inputs: Io[];
  outputs: Io[];
  /** The words of constant buffer `resource`, re-read each frame. */
  buffer(resource: number): Uint32Array | null;
  /** The texture register of texture resource `resource`. */
  register(resource: number): number | null;
}

export interface Scene {
  mode: 'pixel' | 'vertex' | 'compute';
  vertex?: Program;
  pixel?: Program;
  compute?: Program;
  /** Pixel mode: what of the mesh feeds each of the pixel program's inputs (by index into its inputs). */
  feeds: W.Feed[];
  /** Vertex mode with no pixel program: the output location shown. */
  shown: number | null;
  /** The vertex program's inputs' vertex data, by input (vertex mode). */
  attributes?: (mesh: Mesh) => { data: ArrayBuffer; format: GPUVertexFormat; location: number }[];
  mesh: Mesh;
  /** Draw on the screen quad with no camera (pixel mode). */
  quad: boolean;
  wireframe: boolean;
  /** Which colour target to show (by location). */
  target: number;
}

export interface Camera {
  world: Float32Array;
  viewProjection: Float32Array;
  normal: Float32Array;
}

export interface Texture {
  texture: GPUTexture;
  signed: boolean;
}

/** What one capture read back: per lane of the 2 x 2 quad (top row first), each input's and output's words. */
export interface Capture {
  origin: [number, number];
  covered: boolean[];
  inputs: ([number, number, number, number] | null)[][];
  outputs: ([number, number, number, number] | null)[][];
}

const formatOf = (s: Scalar): GPUTextureFormat => (s === 'uint' || s === 'bool' ? 'rgba32uint' : s === 'sint' ? 'rgba32sint' : 'rgba16float');
const exactFormatOf = (s: Scalar): GPUTextureFormat => (s === 'uint' || s === 'bool' ? 'rgba32uint' : s === 'sint' ? 'rgba32sint' : 'rgba32float');
const sampleOf = (f: GPUTextureFormat): 'float' | 'uint' | 'sint' => (f.endsWith('uint') ? 'uint' : f.endsWith('sint') ? 'sint' : 'float');

/** Why WebGPU refused a module: its compilation messages, with line numbers. */
async function compiled(device: GPUDevice, code: string, label: string): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ code, label });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(`${label}: ${errors.map((m) => `line ${m.lineNum}: ${m.message}`).join('; ')}`);
  return module;
}

export class Preview {
  readonly device: GPUDevice;
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  private sampler: GPUSampler;
  private textures = new Map<number, Texture>();
  private fallback: GPUTexture;
  private storage: GPUTexture | null = null;
  private buffers = new Map<string, GPUBuffer>();
  private camera: GPUBuffer;
  private built: Built | null = null;
  private scene: Scene | null = null;
  private building: Promise<void> | null = null;
  private builds = 0;
  private blits = new Map<string, GPURenderPipeline>();
  private fit: GPUBuffer;
  background: [number, number, number, number] = [0.08, 0.08, 0.1, 1];
  /** The optional WebGPU features the device has, which the WGSL may use. */
  get features(): string[] {
    return [...this.device.features];
  }
  lost: string | null = null;
  onLost: (why: string) => void = () => undefined;
  /** A WebGPU error outside a build's error scope: one met while drawing or reading back. */
  onError: (message: string) => void = () => undefined;

  /** A preview on a device with those of the optional `features` the adapter has. */
  static async create(canvas: HTMLCanvasElement, features: string[]): Promise<Preview | string> {
    const rest = 'Everything else works here: the bytes and listing, the interface, the lift and its WGSL, specialising, and runs on the CPU in the Run tab.';
    if (!('gpu' in navigator) || !navigator.gpu)
      return `The live preview needs WebGPU, which this browser does not offer or has turned off. ${rest} For the preview, open the page in a recent Chrome, Edge or Safari, or in Firefox with WebGPU turned on.`;
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    if (!adapter) return `This browser has WebGPU but found no graphics adapter to use (it can be turned off or blocked for this GPU), so there is no live preview. ${rest}`;
    const device = await adapter.requestDevice({ requiredFeatures: features.filter((f) => adapter.features.has(f)) as GPUFeatureName[] });
    const context = canvas.getContext('webgpu');
    if (!context) return `The canvas gave no WebGPU context, so there is no live preview. ${rest}`;
    return new Preview(device, canvas, context);
  }

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement, context: GPUCanvasContext) {
    this.device = device;
    this.canvas = canvas;
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: 'opaque' });
    // the CPU executors sample bilinear, repeating, level 0: so does every sampler here
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    this.fallback = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.fallback }, new Uint8Array([255, 0, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.camera = device.createBuffer({ size: W.CAMERA_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.fit = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.addEventListener('uncapturederror', (e) => this.onError((e as GPUUncapturedErrorEvent).error.message));
    void device.lost.then((info) => {
      this.lost = `The GPU device was lost (${info.reason}): ${info.message}`;
      this.onLost(this.lost);
    });
  }

  /** Bind `pixels` (RGBA8 rows top to bottom) at texture register `register`. */
  setTexture(register: number, width: number, height: number, texels: Uint8Array, signed: boolean): void {
    this.textures.get(register)?.texture.destroy();
    const texture = this.device.createTexture({
      size: [width, height],
      format: signed ? 'rgba8snorm' : 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture }, texels as Uint8Array<ArrayBuffer>, { bytesPerRow: width * 4 }, [width, height]);
    this.textures.set(register, { texture, signed });
    if (this.built) this.built.groups = null;
  }

  /**
   * Build the scene's pipelines: resolves true once they are made and drawn from, false if a later `show` began
   * meanwhile (its scene is the one drawn), or rejects with WebGPU's own words.
   */
  async show(scene: Scene): Promise<boolean> {
    const n = ++this.builds;
    const build = this.build(scene);
    this.building = build.then(
      () => undefined,
      () => undefined,
    );
    // the last frame stays until the new pipelines are made; a scene that fails to build draws nothing
    try {
      const built = await build;
      if (n !== this.builds) {
        built.destroy();
        return false;
      }
      this.built?.destroy();
      this.built = built;
      this.scene = scene;
      return true;
    } catch (e) {
      if (n !== this.builds) return false;
      this.built?.destroy();
      this.built = null;
      this.scene = null;
      throw e;
    }
  }

  private async build(scene: Scene): Promise<Built> {
    const device = this.device;
    device.pushErrorScope('validation');
    try {
      const built = scene.mode === 'compute' ? await this.buildCompute(scene) : await this.buildDraw(scene);
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      return built;
    } catch (e) {
      await device.popErrorScope().catch(() => null);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** The uniform buffer of `program`'s resource `resource`, made on first use. */
  private uniform(program: Program, resource: number, size: number): GPUBuffer {
    const key = `${program.key}:${resource}:${size}`;
    let b = this.buffers.get(key);
    if (!b) {
      b = this.device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.buffers.set(key, b);
    }
    return b;
  }

  /** The bind group layouts for the declarations of `modules`, each group's entries in binding order. */
  private layouts(modules: { program: Program | null; decls: W.Decl[]; visibility: number }[]): {
    layouts: GPUBindGroupLayout[];
    entries: Map<number, { decl: W.Decl; program: Program | null; visibility: number }[]>;
  } {
    const groups = new Map<number, Map<number, { decl: W.Decl; program: Program | null; visibility: number }>>();
    for (const m of modules)
      for (const d of m.decls) {
        let g = groups.get(d.group);
        if (!g) groups.set(d.group, (g = new Map()));
        const had = g.get(d.binding);
        if (had) {
          if (had.decl.type !== d.type || had.program?.key !== m.program?.key)
            throw new Error(`two programs of the pipeline declare @group(${d.group}) @binding(${d.binding}): ${had.decl.name} and ${d.name}`);
          had.visibility |= m.visibility;
        } else g.set(d.binding, { decl: d, program: m.program, visibility: m.visibility });
      }
    const max = Math.max(-1, ...groups.keys());
    if (max >= 4) throw new Error(`the program uses bind group ${max}; WebGPU guarantees 4 (0 to 3)`);
    const layouts: GPUBindGroupLayout[] = [];
    const entries = new Map<number, { decl: W.Decl; program: Program | null; visibility: number }[]>();
    for (let g = 0; g <= max; g++) {
      const list = [...(groups.get(g)?.values() ?? [])].sort((a, b) => a.decl.binding - b.decl.binding);
      entries.set(g, list);
      layouts.push(
        this.device.createBindGroupLayout({
          label: `group ${g}`,
          entries: list.map(({ decl, visibility }) => layoutEntry(decl, visibility)),
        }),
      );
    }
    return { layouts, entries };
  }

  private resourceOf(program: Program | null, decl: W.Decl): number | null {
    return program?.bindings.find((b) => b.group === decl.group && b.binding === decl.binding)?.resource ?? null;
  }

  private bindGroups(built: Built): GPUBindGroup[] {
    const groups: GPUBindGroup[] = [];
    for (const [g, list] of built.entries) {
      groups[g] = this.device.createBindGroup({
        layout: built.layouts[g],
        entries: list.map(({ decl, program }) => ({ binding: decl.binding, resource: this.resource(built, decl, program) })),
      });
    }
    return groups;
  }

  private resource(built: Built, decl: W.Decl, program: Program | null): GPUBindingResource {
    const what = decl.what;
    if (!program) return { buffer: this.camera };
    const id = this.resourceOf(program, decl);
    switch (what.kind) {
      case 'uniform':
      case 'storage-buffer': {
        const words = id === null ? null : program.buffer(id);
        const size = Math.max(what.size, (words?.length ?? 0) * 4, 16);
        const buffer = this.uniform(program, id ?? -1 - decl.binding, size);
        built.uniforms.push({ buffer, program, resource: id });
        return { buffer };
      }
      case 'sampler':
        return this.sampler;
      case 'texture': {
        const register = id === null ? null : program.register(id);
        const t = register === null ? undefined : this.textures.get(register);
        return (t?.texture ?? this.fallback).createView({ dimension: what.view === '2d' ? '2d' : undefined });
      }
      case 'storage-texture': {
        if (!this.storage || this.storage.format !== what.format) {
          this.storage?.destroy();
          this.storage = this.device.createTexture({
            size: [512, 512],
            format: what.format,
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
          });
        }
        built.storage = this.storage;
        return this.storage.createView();
      }
      default:
        throw new Error(`the preview cannot bind ${decl.name}: ${decl.type}`);
    }
  }

  /** The vertex stage of a draw: the program's own, or the page's feeding the pixel program from the mesh. */
  private vertexStage(scene: Scene, pixelDecls: W.Decl[]): { code: string; program: Program | null; buffers: GPUVertexBufferLayout[]; data: GPUBuffer[] } {
    const device = this.device;
    if (scene.mode === 'vertex' && scene.vertex) {
      const attrs = scene.attributes?.(scene.mesh) ?? [];
      const data = attrs.map((a) => {
        const b = device.createBuffer({ size: Math.max(16, a.data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(b, 0, a.data);
        return b;
      });
      return {
        code: scene.vertex.text,
        program: scene.vertex,
        buffers: attrs.map((a) => ({ arrayStride: 16, attributes: [{ shaderLocation: a.location, offset: 0, format: a.format }] })),
        data,
      };
    }
    const pixel = scene.pixel!;
    // the page's camera goes after the pixel program's bindings in group 0
    const binding = Math.max(-1, ...pixelDecls.filter((d) => d.group === 0).map((d) => d.binding)) + 1;
    const mesh = scene.mesh;
    const arrays = [mesh.position, mesh.normal, mesh.tangent, mesh.uv, mesh.color];
    const data = arrays.map((a) => {
      const b = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, a);
      return b;
    });
    return {
      code: W.feederVertex(pixel.inputs, scene.feeds, 0, binding),
      program: null,
      buffers: W.MESH_FORMATS.map((format, i) => ({
        arrayStride: [12, 12, 16, 8, 16][i],
        attributes: [{ shaderLocation: i, offset: 0, format }],
      })),
      data,
    };
  }

  private async buildDraw(scene: Scene): Promise<Built> {
    const device = this.device;
    const pixelProgram = scene.pixel ?? null;
    const pixelCode = pixelProgram ? pixelProgram.text : W.showOutput(scene.vertex?.outputs ?? [], scene.shown);
    const pixelDecls = pixelProgram ? W.declarations(pixelCode) : [];
    const vertex = this.vertexStage(scene, pixelDecls);
    const vertexDecls = W.declarations(vertex.code);
    const { layouts, entries } = this.layouts([
      { program: vertex.program, decls: vertexDecls, visibility: GPUShaderStage.VERTEX },
      { program: pixelProgram, decls: pixelDecls, visibility: GPUShaderStage.FRAGMENT },
    ]);
    const layout = device.createPipelineLayout({ bindGroupLayouts: layouts });
    const vs = await compiled(device, vertex.code, scene.mode === 'vertex' ? 'the vertex program' : "the page's vertex program");
    const fs = await compiled(device, pixelCode, pixelProgram ? 'the pixel program' : "the page's pixel program");
    const outputs = (pixelProgram?.outputs ?? [{ location: 0, scalar: 'float' } as Io]).filter((o) => o.location !== null);
    const max = Math.max(0, ...outputs.map((o) => o.location!));
    const targets: (GPUColorTargetState | null)[] = [];
    for (let l = 0; l <= max; l++) {
      const o = outputs.find((x) => x.location === l);
      targets.push(o ? { format: formatOf(o.scalar) } : null);
    }
    const wireframe = scene.wireframe && !scene.quad;
    // under a wireframe the fill is pushed back by a bias so that its edges, drawn at the same depths, pass a
    // less-equal test: WebGPU allows no depth bias on line (or point) topologies, so the lines cannot carry it
    const depthStencil: GPUDepthStencilState = { format: 'depth24plus', depthCompare: 'less', depthWriteEnabled: true, ...(wireframe ? { depthBias: 2, depthBiasSlopeScale: 1 } : {}) };
    const base = { layout, vertex: { module: vs, entryPoint: 'main', buffers: vertex.buffers } };
    const pipeline = await device.createRenderPipelineAsync({
      ...base,
      depthStencil,
      label: 'preview',
      fragment: { module: fs, entryPoint: 'main', targets },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    let wire: GPURenderPipeline | null = null;
    if (wireframe) {
      const flat = await compiled(device, W.FLAT_COLOUR, 'wireframe');
      wire = await device.createRenderPipelineAsync({
        ...base,
        label: 'wireframe',
        depthStencil: { format: 'depth24plus', depthCompare: 'less-equal', depthWriteEnabled: false },
        fragment: { module: flat, entryPoint: 'main', targets: targets.map((t, i) => (i === scene.target && t ? { format: t.format } : t ? { format: t.format, writeMask: 0 } : null)) },
        primitive: { topology: 'line-list' },
      });
    }
    const index = device.createBuffer({ size: scene.mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(index, 0, scene.mesh.indices);
    const edges = device.createBuffer({ size: Math.max(4, scene.mesh.edges.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(edges, 0, scene.mesh.edges);
    return new Built({
      kind: 'draw',
      layouts,
      entries,
      pipeline,
      wire,
      vertexBuffers: vertex.data,
      index,
      edges,
      indexCount: scene.mesh.indices.length,
      edgeCount: scene.mesh.edges.length,
      targets,
      layout,
      vs,
      fs,
      vertexLayouts: vertex.buffers,
      vertexCode: vertex.code,
      pixelInputs: pixelProgram?.inputs ?? scene.vertex?.outputs.filter((o) => o.location !== null) ?? [],
      pixelDecls,
    });
  }

  private async buildCompute(scene: Scene): Promise<Built> {
    const program = scene.compute!;
    const decls = W.declarations(program.text);
    const { layouts, entries } = this.layouts([{ program, decls, visibility: GPUShaderStage.COMPUTE }]);
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: layouts });
    const module = await compiled(this.device, program.text, 'the compute program');
    const pipeline = await this.device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'main' } });
    return new Built({ kind: 'compute', layouts, entries, compute: pipeline, workgroup: W.entry(program.text).workgroup, layout });
  }

  /** Draw a frame with `camera`; returns false while nothing is built. */
  frame(camera: Camera): boolean {
    const built = this.built;
    const scene = this.scene;
    if (!built || !scene || this.lost) return false;
    const device = this.device;
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    built.groups ??= ((built.uniforms = []), this.bindGroups(built));
    for (const u of built.uniforms) {
      const words = u.resource === null ? null : u.program.buffer(u.resource);
      if (words) device.queue.writeBuffer(u.buffer, 0, words.buffer, words.byteOffset, Math.min(words.byteLength, u.buffer.size));
    }
    const cam = new Float32Array(48);
    cam.set(transpose(scene.quad ? IDENTITY : camera.world), 0);
    cam.set(transpose(scene.quad ? IDENTITY : camera.viewProjection), 16);
    cam.set(transpose(scene.quad ? IDENTITY : camera.normal), 32);
    device.queue.writeBuffer(this.camera, 0, cam);
    const encoder = device.createCommandEncoder();
    let shown: GPUTexture | null = null;
    let fit = { offset: [0, 0], scale: [1, 1] };
    if (built.kind === 'compute' && built.compute) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(built.compute);
      built.groups.forEach((g, i) => pass.setBindGroup(i, g));
      const [wx, wy] = built.workgroup;
      pass.dispatchWorkgroups(Math.ceil(512 / wx), Math.ceil(512 / wy), 1);
      pass.end();
      shown = built.storage;
      // the image fitted to the canvas, centred
      const s = Math.min(width, height) / 512;
      fit = { offset: [(width - 512 * s) / 2, (height - 512 * s) / 2], scale: [1 / s, 1 / s] };
    } else {
      built.ensureTargets(device, width, height);
      this.drawInto(encoder, built, built.colour!, built.depth!, null);
      shown = built.colour![scene.target] ?? built.colour!.find(Boolean) ?? null;
    }
    if (shown) {
      device.queue.writeBuffer(this.fit, 0, new Float32Array([...fit.offset, ...fit.scale, ...this.background]));
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: this.background }],
      });
      pass.setPipeline(this.blitPipeline(sampleOf(shown.format)));
      pass.setBindGroup(0, device.createBindGroup({ layout: this.blitPipeline(sampleOf(shown.format)).getBindGroupLayout(0), entries: [{ binding: 0, resource: shown.createView() }, { binding: 1, resource: { buffer: this.fit } }] }));
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
    return true;
  }

  private drawInto(encoder: GPUCommandEncoder, built: Built, colour: (GPUTexture | null)[], depth: GPUTexture, override: { pipeline: GPURenderPipeline; scissor: [number, number, number, number] | null; points?: number } | null): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: colour.map((t) => (t ? { view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: override ? [0, 0, 0, 0] : this.background } : null)),
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'store' },
    });
    pass.setPipeline(override?.pipeline ?? built.pipeline!);
    built.groups!.forEach((g, i) => pass.setBindGroup(i, g));
    built.vertexBuffers!.forEach((b, i) => pass.setVertexBuffer(i, b));
    if (override?.scissor) pass.setScissorRect(...override.scissor);
    if (override?.points !== undefined) {
      pass.draw(1, 1, override.points, 0);
    } else {
      pass.setIndexBuffer(built.index!, 'uint32');
      pass.drawIndexed(built.indexCount);
      if (!override && built.wire) {
        pass.setPipeline(built.wire);
        pass.setIndexBuffer(built.edges!, 'uint32');
        pass.drawIndexed(built.edgeCount);
      }
    }
    pass.end();
  }

  private blitPipeline(sample: 'float' | 'uint' | 'sint'): GPURenderPipeline {
    let p = this.blits.get(sample);
    if (!p) {
      const module = this.device.createShaderModule({ code: W.blit(sample) });
      p = this.device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] } });
      this.blits.set(sample, p);
    }
    return p;
  }

  /**
   * What the GPU gave at canvas pixel (x, y): the 2 x 2 quad holding it drawn again into exact targets, once per pixel
   * input with a capture program that writes the bits it received, once with the program's outputs as `rgba32float`
   * (or integer) targets. Depth testing keeps the same surface in each pass.
   */
  async capturePixel(x: number, y: number): Promise<Capture> {
    await this.building;
    const built = this.built;
    const scene = this.scene;
    if (!built || !scene || built.kind !== 'draw') throw new Error('nothing is drawn to read back');
    const device = this.device;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const ox = Math.min(width - 2, Math.max(0, x & ~1));
    const oy = Math.min(height - 2, Math.max(0, y & ~1));
    const scissor: [number, number, number, number] = [ox, oy, 2, 2];
    const depth = device.createTexture({ size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const inputs = built.pixelInputs;
    const read = async (pipelineFor: () => Promise<GPURenderPipeline>, formats: (GPUTextureFormat | null)[]) => {
      const textures = formats.map((f) => (f ? device.createTexture({ size: [width, height], format: f, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }) : null));
      const pipeline = await pipelineFor();
      const encoder = device.createCommandEncoder();
      this.drawInto(encoder, built, textures, depth, { pipeline, scissor });
      const out = await Promise.all(textures.map((t) => (t ? readQuad(device, encoder, t, ox, oy) : Promise.resolve(null))));
      textures.forEach((t) => t?.destroy());
      return out;
    };
    const base = (fs: GPUShaderModule, targets: (GPUColorTargetState | null)[]): Promise<GPURenderPipeline> =>
      device.createRenderPipelineAsync({
        layout: built.layout,
        vertex: { module: built.vs!, entryPoint: 'main', buffers: built.vertexLayouts! },
        fragment: { module: fs, entryPoint: 'main', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthCompare: 'less', depthWriteEnabled: true },
      });
    const lanes = (words: Uint32Array | null) => [0, 1, 2, 3].map((l) => (words ? (Array.from(words.slice(l * 4, l * 4 + 4)) as [number, number, number, number]) : null));
    // coverage: the position the pixel program received (its w is never 0 where a fragment ran)
    const positionIo: Io = { name: 'position', varying: -1, location: null, builtin: 'position', scalar: 'float', width: 4, interpolation: null, sampling: null };
    const coverageCode = W.captureInput([...inputs.filter((i) => i.builtin !== 'position'), positionIo], inputs.filter((i) => i.builtin !== 'position').length);
    const [coverage] = await read(async () => base(await compiled(device, coverageCode, 'coverage capture'), [{ format: 'rgba32uint' }]), ['rgba32uint']);
    const covered = lanes(coverage).map((w) => !!w && w[3] !== 0);
    const capturedInputs: ([number, number, number, number] | null)[][] = [[], [], [], []];
    for (let k = 0; k < inputs.length; k++) {
      const code = W.captureInput(inputs, k);
      const [words] = await read(async () => base(await compiled(device, code, `capture of ${inputs[k].name}`), [{ format: 'rgba32uint' }]), ['rgba32uint']);
      lanes(words).forEach((w, lane) => (capturedInputs[lane][k] = w));
    }
    const outputs = (scene.pixel?.outputs ?? []).filter((o) => o.location !== null);
    const formats: (GPUTextureFormat | null)[] = [];
    for (const o of outputs) formats[o.location!] = exactFormatOf(o.scalar);
    for (let i = 0; i < formats.length; i++) formats[i] ??= null;
    const capturedOutputs: ([number, number, number, number] | null)[][] = [[], [], [], []];
    if (formats.length) {
      const words = await read(async () => base(built.fs!, formats.map((f) => (f ? { format: f } : null))), formats);
      words.forEach((w, location) => lanes(w).forEach((lane, l) => (capturedOutputs[l][location] = lane)));
    }
    depth.destroy();
    return { origin: [ox, oy], covered, inputs: capturedInputs, outputs: capturedOutputs };
  }

  /** A compute program's texel (x, y) of its storage image, and the canvas pixel's texel. */
  async captureTexel(cx: number, cy: number): Promise<{ texel: [number, number]; words: [number, number, number, number] } | null> {
    await this.building;
    const built = this.built;
    if (!built || built.kind !== 'compute' || !built.storage) return null;
    const s = Math.min(this.canvas.width, this.canvas.height) / 512;
    const tx = Math.floor((cx - (this.canvas.width - 512 * s) / 2) / s);
    const ty = Math.floor((cy - (this.canvas.height - 512 * s) / 2) / s);
    if (tx < 0 || ty < 0 || tx >= 512 || ty >= 512) return null;
    const encoder = this.device.createCommandEncoder();
    const words = await readTexel(this.device, encoder, built.storage, tx, ty);
    return { texel: [tx, ty], words: Array.from(words.slice(0, 4)) as [number, number, number, number] };
  }

  /**
   * A vertex program's outputs for vertex `vertex`, read back through one point primitive: the program draws only
   * that vertex, and a capture program writes the bits each output varying carries where the point lands.
   */
  async captureVertex(vertex: number): Promise<{ at: [number, number] | null; outputs: ([number, number, number, number] | null)[] }> {
    await this.building;
    const built = this.built;
    const scene = this.scene;
    if (!built || !scene || built.kind !== 'draw' || scene.mode !== 'vertex' || !scene.vertex) throw new Error('no vertex program is drawn');
    const device = this.device;
    const size = 256;
    const outs = scene.vertex.outputs.filter((o) => o.location !== null);
    const depth = device.createTexture({ size: [size, size], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const result: ([number, number, number, number] | null)[] = [];
    let at: [number, number] | null = null;
    for (let k = 0; k < outs.length; k++) {
      const code = W.captureInput(outs, k);
      const fs = await compiled(device, code, `capture of ${outs[k].name}`);
      // the target is cleared to zeros: the point's pixel is the one texel written (an output of all-zero bits there
      // reads as no point, and is reported as not landing)
      const pipeline = await device.createRenderPipelineAsync({
        layout: built.layout,
        vertex: { module: built.vs!, entryPoint: 'main', buffers: built.vertexLayouts! },
        fragment: { module: fs, entryPoint: 'main', targets: [{ format: 'rgba32uint' }] },
        primitive: { topology: 'point-list' },
        depthStencil: { format: 'depth24plus', depthCompare: 'always', depthWriteEnabled: false },
      });
      const target = device.createTexture({ size: [size, size], format: 'rgba32uint', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const encoder = device.createCommandEncoder();
      this.drawInto(encoder, built, [target], depth, { pipeline, scissor: null, points: vertex });
      const words = await readWhole(device, encoder, target, size, size);
      target.destroy();
      // the point's pixel: the first texel any lane of which is not the clear value, found by the first output
      if (k === 0) {
        for (let i = 0; i < size * size && !at; i++) if (words[i * 4] || words[i * 4 + 1] || words[i * 4 + 2] || words[i * 4 + 3]) at = [i % size, Math.floor(i / size)];
      }
      result[outs[k].location!] = at ? (Array.from(words.slice((at[1] * size + at[0]) * 4, (at[1] * size + at[0]) * 4 + 4)) as [number, number, number, number]) : null;
    }
    depth.destroy();
    return { at, outputs: result };
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const transpose = (m: Float32Array): Float32Array => {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = m[r * 4 + c];
  return out;
};

function layoutEntry(decl: W.Decl, visibility: number): GPUBindGroupLayoutEntry {
  const w = decl.what;
  switch (w.kind) {
    case 'uniform':
      return { binding: decl.binding, visibility, buffer: { type: 'uniform' } };
    case 'storage-buffer':
      return { binding: decl.binding, visibility, buffer: { type: w.access === 'read' ? 'read-only-storage' : 'storage' } };
    case 'sampler':
      return { binding: decl.binding, visibility, sampler: { type: w.comparison ? 'comparison' : 'filtering' } };
    case 'texture':
      return { binding: decl.binding, visibility, texture: { sampleType: w.sample, viewDimension: w.view, multisampled: w.multisampled } };
    case 'storage-texture':
      return { binding: decl.binding, visibility, storageTexture: { access: w.access, format: w.format, viewDimension: w.view } };
    default:
      throw new Error(`the preview cannot bind ${decl.name}: ${decl.type}`);
  }
}

async function readQuad(device: GPUDevice, encoder: GPUCommandEncoder, texture: GPUTexture, x: number, y: number): Promise<Uint32Array> {
  // 2 x 2 texels of 16 bytes: rows padded to 256 bytes
  const buffer = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture, origin: [x, y] }, { buffer, bytesPerRow: 256 }, [2, 2]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const all = new Uint32Array(buffer.getMappedRange().slice(0));
  buffer.destroy();
  const out = new Uint32Array(16);
  out.set(all.slice(0, 8), 0);
  out.set(all.slice(64, 72), 8);
  return out;
}

async function readTexel(device: GPUDevice, encoder: GPUCommandEncoder, texture: GPUTexture, x: number, y: number): Promise<Uint32Array> {
  const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture, origin: [x, y] }, { buffer, bytesPerRow: 256 }, [1, 1]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(buffer.getMappedRange().slice(0, 16));
  buffer.destroy();
  return out;
}

async function readWhole(device: GPUDevice, encoder: GPUCommandEncoder, texture: GPUTexture, width: number, height: number): Promise<Uint32Array> {
  const row = width * 16;
  const buffer = device.createBuffer({ size: row * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(buffer.getMappedRange().slice(0));
  buffer.destroy();
  return out;
}

interface BuiltParts {
  kind: 'draw' | 'compute';
  layouts: GPUBindGroupLayout[];
  entries: Map<number, { decl: W.Decl; program: Program | null; visibility: number }[]>;
  layout: GPUPipelineLayout;
  pipeline?: GPURenderPipeline;
  wire?: GPURenderPipeline | null;
  compute?: GPUComputePipeline;
  workgroup?: [number, number, number];
  vertexBuffers?: GPUBuffer[];
  index?: GPUBuffer;
  edges?: GPUBuffer;
  indexCount?: number;
  edgeCount?: number;
  targets?: (GPUColorTargetState | null)[];
  vs?: GPUShaderModule;
  fs?: GPUShaderModule;
  vertexLayouts?: GPUVertexBufferLayout[];
  vertexCode?: string;
  pixelInputs?: Io[];
  pixelDecls?: W.Decl[];
}

class Built {
  kind: 'draw' | 'compute';
  layouts: GPUBindGroupLayout[];
  entries: Map<number, { decl: W.Decl; program: Program | null; visibility: number }[]>;
  layout: GPUPipelineLayout;
  pipeline: GPURenderPipeline | null;
  wire: GPURenderPipeline | null;
  compute: GPUComputePipeline | null;
  workgroup: [number, number, number];
  vertexBuffers: GPUBuffer[];
  index: GPUBuffer | null;
  edges: GPUBuffer | null;
  indexCount: number;
  edgeCount: number;
  targets: (GPUColorTargetState | null)[];
  vs: GPUShaderModule | null;
  fs: GPUShaderModule | null;
  vertexLayouts: GPUVertexBufferLayout[];
  vertexCode: string;
  pixelInputs: Io[];
  pixelDecls: W.Decl[];
  groups: GPUBindGroup[] | null = null;
  uniforms: { buffer: GPUBuffer; program: Program; resource: number | null }[] = [];
  storage: GPUTexture | null = null;
  colour: (GPUTexture | null)[] | null = null;
  depth: GPUTexture | null = null;
  private size: [number, number] = [0, 0];

  constructor(p: BuiltParts) {
    this.kind = p.kind;
    this.layouts = p.layouts;
    this.entries = p.entries;
    this.layout = p.layout;
    this.pipeline = p.pipeline ?? null;
    this.wire = p.wire ?? null;
    this.compute = p.compute ?? null;
    this.workgroup = p.workgroup ?? [1, 1, 1];
    this.vertexBuffers = p.vertexBuffers ?? [];
    this.index = p.index ?? null;
    this.edges = p.edges ?? null;
    this.indexCount = p.indexCount ?? 0;
    this.edgeCount = p.edgeCount ?? 0;
    this.targets = p.targets ?? [];
    this.vs = p.vs ?? null;
    this.fs = p.fs ?? null;
    this.vertexLayouts = p.vertexLayouts ?? [];
    this.vertexCode = p.vertexCode ?? '';
    this.pixelInputs = p.pixelInputs ?? [];
    this.pixelDecls = p.pixelDecls ?? [];
  }

  ensureTargets(device: GPUDevice, width: number, height: number): void {
    if (this.colour && this.size[0] === width && this.size[1] === height) return;
    this.colour?.forEach((t) => t?.destroy());
    this.depth?.destroy();
    this.colour = this.targets.map((t) => (t ? device.createTexture({ size: [width, height], format: t.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }) : null));
    this.depth = device.createTexture({ size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.size = [width, height];
  }

  destroy(): void {
    this.colour?.forEach((t) => t?.destroy());
    this.depth?.destroy();
    this.vertexBuffers.forEach((b) => b.destroy());
    this.index?.destroy();
    this.edges?.destroy();
  }
}

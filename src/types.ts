// The glue's JSON (glue/src): what `Shader.report()`, `specialise()`, `execute()` and `link()` hand back.

export type Result<T> = { Ok: T } | { Err: string };

export const ok = <T>(r: Result<T>): T | undefined => ('Ok' in r ? r.Ok : undefined);
export const err = <T>(r: Result<T>): string | undefined => ('Err' in r ? r.Err : undefined);

export type Scalar = 'bool' | 'sint' | 'uint' | 'float' | 'double';
export interface Value { scalar: Scalar; width: number }
export interface Label { name: string; index: number }

export type SystemValue = string | { target: number } | Record<string, unknown>;

export interface Varying {
  label: Label;
  system: SystemValue | null;
  value: Value;
  interp: string | null;
  used: boolean;
  provenance: { d3d?: { register: number; mask: number; read_write_mask?: number; [k: string]: unknown } };
}

export type Majorness = 'row' | 'column';
export type ConstantType =
  | { scalar: Scalar }
  | { vector: Value }
  | { matrix: { scalar: Scalar; rows: number; columns: number; major: Majorness; stride: number } }
  | { array: { element: ConstantType; count: number; stride: number } }
  | { struct: { members: { name: string; offset: number; ty: ConstantType }[] } };

export interface Constant { name: string; offset: number; ty: ConstantType; default: number[] | null }
export interface BufferLayout { size: number; constants: Constant[] }

export type StateParam =
  | { projected: number }
  | { texture_dim: number }
  | { bump_env_mat: number }
  | { bump_l_scale: number }
  | { bump_l_offset: number };

export type ResourceKind =
  | { constant_buffer: { layout: BufferLayout } }
  | { texture: { dim: string; arrayed: boolean; multisampled: boolean; sample: string } }
  | { sampler: { comparison: boolean } }
  | { buffer: unknown }
  | { storage: { target: unknown; access: string } }
  | 'acceleration_structure'
  | { pipeline_state: StateParam };

export interface Resource {
  id: number;
  kind: ResourceKind;
  count: number;
  provenance: { name: string; d3d?: { class: string; register: number; space: number } };
}

export interface Interface {
  stage: string;
  inputs: Varying[];
  outputs: Varying[];
  resources: Resource[];
  facts: unknown;
}

export interface Region { label: string; tag: string | null; start: number; end: number }
export interface Instruction { line: number; start: number; end: number }
export interface Bytecode { regions: Region[]; listing: Result<string>; instructions: Instruction[]; code_base: number }

export interface Lifted { kind: 'ir' | 'legacy'; text: string; origins: [number, number][] }

export interface Io {
  name: string;
  varying: number;
  location: number | null;
  builtin: string | null;
  scalar: Scalar;
  width: number;
  interpolation: string | null;
  sampling: string | null;
}
export interface Binding { resource: number; group: number; binding: number }
export interface Wgsl { text: string; bindings: Binding[]; inputs: Io[]; outputs: Io[] }

export interface Source { kind: 'input' | 'texel' | 'constant'; index: number; at: number; via: string }
export interface Reach { output: number; lane: number; sources: Source[] }
export type MatrixLines = 'rows' | 'columns' | { unshown: unknown };
export interface MatrixAnalysis { resource: number; name: string; offset: number; lines: MatrixLines }
export interface Analyses {
  reach: Result<Reach[]>;
  discard: Source[];
  matrices: MatrixAnalysis[];
  constants_read: [number, number[]][];
}

export interface StateInfo { resource: number; param: StateParam; default: [number, number, number, number] }

export interface Report {
  format: 'dxbc' | 'dxil' | 'd3d9';
  size: number;
  target: string | null;
  lifter: string | null;
  path: 'ir' | 'legacy';
  bytecode: Bytecode;
  interface: Interface | null;
  refusal: { message: string; byte: number | null } | null;
  lifted: Result<Lifted>;
  wgsl: Result<Wgsl>;
  notes: string[];
  state: StateInfo[];
  analyses: Result<Analyses>;
  executors: string[];
  needs_quad: boolean;
}

export interface Pins { words: [number, number, number][]; state: [number, [number, number, number, number]][] }

export interface Specialised {
  by: string;
  before: Lifted;
  wgsl_before: Result<string>;
  lifted: Lifted;
  wgsl: Result<string>;
  folded: number | null;
  unread: string[];
  ignored: string[];
}

export interface Request {
  lanes: { inputs: [number, number, number, number][] }[];
  buffers: [number, number[]][];
  state: [number, [number, number, number, number]][];
}
export interface LaneResult { outputs: ([number, number, number, number] | null)[]; killed: boolean }
export interface Executed { executor: string; runs: string; lanes: Result<LaneResult[]> }

export interface Linked { path: string; wgsl: Wgsl; notes: string[] }

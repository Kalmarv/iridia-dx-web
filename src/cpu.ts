// What a program receives without a GPU to read it back from: the inputs the page's preview would feed, computed on the
// CPU, so that the Run tab runs iridia's executors in a browser with no WebGPU.
import type { Feed } from './gpu/wgsl';
import { floatBits } from './constants';
import type { Interface, Io } from './types';

export type Words = [number, number, number, number];

/** The side of the screen quad the CPU runs on, in pixels. */
export const SCREEN = 512;

/** `value` as the words of a varying of `io`'s type: float bits, or integers converted as WGSL's `u32()`/`i32()` do. */
function words(value: number[], io: Io): Words {
  const out: Words = [0, 0, 0, 0];
  for (let l = 0; l < Math.min(4, io.width); l++) {
    const v = value[l] ?? 0;
    out[l] = io.scalar === 'uint' || io.scalar === 'bool' ? Math.max(0, Math.trunc(v)) >>> 0 : io.scalar === 'sint' ? Math.trunc(v) | 0 : floatBits(v);
  }
  return out;
}

/**
 * The screen quad's values at pixel (x, y) of a `SCREEN`-square view, as the preview's feeder vertex program gives
 * them there: the quad spans clip space with an identity camera, so its world position is its clip position, its
 * texture coordinate runs (0, 0) at the top left to (1, 1), its normal faces the viewer.
 */
function feedAt(feed: Feed, x: number, y: number): number[] {
  const u = (x + 0.5) / SCREEN;
  const v = (y + 0.5) / SCREEN;
  const clip = [u * 2 - 1, 1 - v * 2, 0, 1];
  switch (feed) {
    case 'uv':
      return [u, v, 0, 1];
    case 'world':
      return [clip[0], clip[1], 0, 1];
    case 'normal':
      return [0, 0, 1, 0];
    case 'tangent':
      return [1, 0, 0, 1];
    case 'color':
      // the mesh's colour from its normal, (0, 0, 1) here
      return [0.6, 0.6, 1, 1];
    case 'clip':
      return clip;
    case 'screen':
      return [u, v, 0, 1];
    case 'zero':
      return [0, 0, 0, 0];
  }
}

/**
 * A pixel program's interface inputs (by index) at each pixel of the 2 x 2 quad at (x, y), top row first, on the
 * screen quad: `inputs` are its WGSL entry's arguments, fed as `feeds` says.
 */
export function screenQuadInputs(iface: Interface, inputs: Io[], feeds: Feed[], x: number, y: number): Words[][] {
  const ox = Math.min(SCREEN - 2, Math.max(0, x & ~1));
  const oy = Math.min(SCREEN - 2, Math.max(0, y & ~1));
  return [0, 1, 2, 3].map((l) => {
    const px = ox + (l & 1);
    const py = oy + (l >> 1);
    const out: Words[] = iface.inputs.map(() => [0, 0, 0, 0]);
    inputs.forEach((io, k) => {
      if (io.varying < 0 || io.varying >= out.length) return;
      // the fragment's position: the pixel's centre, depth 0 (the quad's), 1 / w = 1
      out[io.varying] = io.builtin === 'position' ? words([px + 0.5, py + 0.5, 0, 1], { ...io, scalar: 'float', width: 4 }) : words(feedAt(feeds[k] ?? 'uv', px, py), io);
    });
    return out;
  });
}

/** Which lane of the quad (x, y) is in, top row first. */
export const laneOf = (x: number, y: number): number => (y & 1) * 2 + (x & 1);

/**
 * A pixel program's inputs where a pixel lands on a vertex: what the linked vertex program wrote for it, matched by
 * semantic (an output the pixel program reads with the same name and index), and the clip position it wrote as the
 * fragment's position in a `SCREEN`-square view.
 */
export function inputsFromVertex(vertex: Interface, outputs: (Words | null)[], pixel: Interface, inputs: Io[]): Words[] {
  const out: Words[] = pixel.inputs.map(() => [0, 0, 0, 0]);
  const clipAt = vertex.outputs.findIndex((o) => /^(SV_)?POSITION$/i.test(o.label.name) && o.label.index === 0);
  for (const io of inputs) {
    if (io.varying < 0 || io.varying >= out.length) continue;
    if (io.builtin === 'position') {
      const c = clipAt >= 0 ? outputs[clipAt] : null;
      if (!c) continue;
      const [cx, cy, cz, cw] = c.map((w) => new Float32Array(new Uint32Array([w]).buffer)[0]);
      out[io.varying] = words([((cx / cw) * 0.5 + 0.5) * SCREEN, (0.5 - (cy / cw) * 0.5) * SCREEN, cz / cw, 1 / cw], { ...io, scalar: 'float', width: 4 });
      continue;
    }
    const label = pixel.inputs[io.varying].label;
    const from = vertex.outputs.findIndex((o) => o.label.name.toUpperCase() === label.name.toUpperCase() && o.label.index === label.index);
    if (from >= 0 && outputs[from]) out[io.varying] = outputs[from]!;
  }
  return out;
}

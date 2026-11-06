// 4 x 4 matrices, row-major in memory (m[row * 4 + column]), applied to column vectors; clip depth 0 to 1 (WebGPU).
export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

export const identity = (): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  return out;
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = (far * near) / (near - far);
  m[14] = -1;
  return m;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], x[1], x[2], -dot(x, eye), y[0], y[1], y[2], -dot(y, eye), z[0], z[1], z[2], -dot(z, eye), 0, 0, 0, 1]);
}

export function transformPoint(m: Mat4, p: Vec3): [number, number, number, number] {
  const v = [p[0], p[1], p[2], 1];
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) out[r] = m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2] + m[r * 4 + 3] * v[3];
  return out;
}

/** An orbit camera: yaw and pitch about a target at a distance. */
export class Orbit {
  yaw = 0.6;
  pitch = 0.35;
  distance = 3.2;
  target: Vec3 = [0, 0, 0];
  fov = 0.9;

  eye(): Vec3 {
    const c = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * c * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * c * Math.cos(this.yaw),
    ];
  }

  view(): Mat4 {
    return lookAt(this.eye(), this.target, [0, 1, 0]);
  }

  projection(aspect: number): Mat4 {
    return perspective(this.fov, aspect, 0.05, 100);
  }

  drag(dx: number, dy: number): void {
    this.yaw -= dx * 0.008;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.008));
  }

  zoom(delta: number): void {
    this.distance = Math.max(1.2, Math.min(12, this.distance * Math.exp(delta * 0.001)));
  }
}

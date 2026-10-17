import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Mesh, ShaderMaterial, type IUniform } from 'three';
import { PALETTE, capHdr, type VfxElement } from './palette.js';

/** Blade rows: position = base + (tip − base) × s; the strip spans s ∈ [S_LOW, S_HIGH], the razor edge sits at s = 1. */
export const TRAIL_S_LOW = -0.2;
export const TRAIL_S_HIGH = 1.3;
const SAMPLE_CAPACITY = 48;
const MAX_ROWS = 192;
/** Samples further apart than this start a new swing instead of bridging the gap. */
const MAX_GAP_SECONDS = 0.12;
/** One sub-sample per this much tip travel (metres), at most `MAX_SUBDIVISIONS` per frame interval. */
const SUBDIVISION_STEP = 0.09;
const MAX_SUBDIVISIONS = 6;
/** Floor for the centripetal knot spacing so coincident samples never divide by zero. */
const KNOT_MIN = 1e-3;

/** Output buffers the sampler writes the swept strip into (two vertices per row: s = low, s = high). */
export interface TrailBuffers {
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
  readonly weights: Float32Array;
}

/**
 * History of (blade base, blade tip) world positions, one per rendered frame, expanded into a smooth strip
 * with centripetal Catmull-Rom sub-samples (no cusps or self-loops, so crescents stay crisp at any frame
 * rate). Framework-free so it can be tested without a GPU.
 */
export class TrailSampler {
  readonly capacity = SAMPLE_CAPACITY;
  /** base xyz, tip xyz, time, weight */
  private readonly data = new Float64Array(SAMPLE_CAPACITY * 8);
  private readonly order = new Int32Array(SAMPLE_CAPACITY);
  private readonly p = new Float64Array(24);
  private head = 0;
  private count = 0;

  /**
   * Records a sample. Rejects non-finite values and times that do not advance (hit-stop freezes the world
   * clock, so the same instant is never recorded twice). A long gap starts a fresh swing.
   */
  push(bx: number, by: number, bz: number, tx: number, ty: number, tz: number, time: number, weight: number): boolean {
    if (!Number.isFinite(bx + by + bz + tx + ty + tz + time + weight)) return false;
    if (this.count > 0) {
      const last = ((this.head - 1 + SAMPLE_CAPACITY) % SAMPLE_CAPACITY) * 8, dt = time - this.data[last + 6]!;
      if (!(dt > 1e-6)) return false;
      if (dt > MAX_GAP_SECONDS) this.clear();
    }
    const o = this.head * 8, d = this.data;
    d[o] = bx; d[o + 1] = by; d[o + 2] = bz; d[o + 3] = tx; d[o + 4] = ty; d[o + 5] = tz; d[o + 6] = time; d[o + 7] = Math.min(1, Math.max(0, weight));
    this.head = (this.head + 1) % SAMPLE_CAPACITY;
    this.count = Math.min(SAMPLE_CAPACITY, this.count + 1);
    return true;
  }

  clear(): void { this.count = 0; this.head = 0; }
  get size(): number { return this.count; }

  /** Writes the newest tip travel direction (unit vector) into `out`; false with fewer than two samples. */
  tipDirection(out: { x: number; y: number; z: number }): boolean {
    if (this.count < 2) return false;
    const a = ((this.head - 1 + SAMPLE_CAPACITY) % SAMPLE_CAPACITY) * 8, b = ((this.head - 2 + SAMPLE_CAPACITY) % SAMPLE_CAPACITY) * 8, d = this.data;
    const x = d[a + 3]! - d[b + 3]!, y = d[a + 4]! - d[b + 4]!, z = d[a + 5]! - d[b + 5]!, length = Math.hypot(x, y, z);
    if (length < 1e-6) return false;
    out.x = x / length; out.y = y / length; out.z = z / length;
    return true;
  }

  /**
   * Builds the strip for samples younger than `life` seconds at `time` into `out`, oldest first. Returns the
   * number of rows (≥ 2 to draw). Row times increase strictly; `uvs.x` is the age fraction (0 newest … 1 oldest).
   */
  build(time: number, life: number, out: TrailBuffers): number {
    const d = this.data, order = this.order;
    let n = 0;
    for (let k = 0; k < this.count; k++) {
      const index = (this.head - 1 - k + SAMPLE_CAPACITY * 2) % SAMPLE_CAPACITY;
      if (time - d[index * 8 + 6]! >= life) break;
      order[n++] = index;
    }
    if (n < 2) return 0;
    let rows = 0;
    for (let i = n - 1; i >= 1 && rows < MAX_ROWS - 1; i--) {
      const a = order[i]! * 8, b = order[i - 1]! * 8, last = i === 1;
      this.load(0, i + 1 < n ? order[i + 1]! * 8 : -1, a, b);
      this.load(1, a, a, b); this.load(2, b, a, b);
      this.load(3, i - 2 >= 0 ? order[i - 2]! * 8 : -1, a, b);
      const tipDistance = Math.hypot(d[b + 3]! - d[a + 3]!, d[b + 4]! - d[a + 4]!, d[b + 5]! - d[a + 5]!);
      const steps = Math.min(MAX_SUBDIVISIONS, Math.max(1, Math.ceil(tipDistance / SUBDIVISION_STEP)));
      const p = this.p;
      // Centripetal knots (alpha 0.5) on the six blade coordinates; t1 = 0 is sample `a`.
      const t0 = -Math.sqrt(Math.max(KNOT_MIN, this.distance(0, 1)));
      const t1 = 0;
      const t2 = Math.sqrt(Math.max(KNOT_MIN, this.distance(1, 2)));
      const t3 = t2 + Math.sqrt(Math.max(KNOT_MIN, this.distance(2, 3)));
      for (let s = 0; s <= (last ? steps : steps - 1) && rows < MAX_ROWS; s++) {
        const f = s / steps, t = t1 + (t2 - t1) * f;
        for (let c = 0; c < 6; c++) {
          const p0 = p[c]!, p1 = p[6 + c]!, p2 = p[12 + c]!, p3 = p[18 + c]!;
          const a1 = ((t1 - t) * p0 + (t - t0) * p1) / (t1 - t0), a2 = ((t2 - t) * p1 + (t - t1) * p2) / (t2 - t1), a3 = ((t3 - t) * p2 + (t - t2) * p3) / (t3 - t2);
          const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0), b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
          this.out[c] = ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1);
        }
        const ts = d[a + 6]! + (d[b + 6]! - d[a + 6]!) * f, weight = d[a + 7]! + (d[b + 7]! - d[a + 7]!) * f, age = Math.min(1, Math.max(0, (time - ts) / life));
        const bx = this.out[0]!, by = this.out[1]!, bz = this.out[2]!, dx = this.out[3]! - bx, dy = this.out[4]! - by, dz = this.out[5]! - bz;
        const v = rows * 2;
        out.positions[v * 3] = bx + dx * TRAIL_S_LOW; out.positions[v * 3 + 1] = by + dy * TRAIL_S_LOW; out.positions[v * 3 + 2] = bz + dz * TRAIL_S_LOW;
        out.positions[v * 3 + 3] = bx + dx * TRAIL_S_HIGH; out.positions[v * 3 + 4] = by + dy * TRAIL_S_HIGH; out.positions[v * 3 + 5] = bz + dz * TRAIL_S_HIGH;
        out.uvs[v * 2] = age; out.uvs[v * 2 + 1] = TRAIL_S_LOW; out.uvs[v * 2 + 2] = age; out.uvs[v * 2 + 3] = TRAIL_S_HIGH;
        out.weights[v] = weight; out.weights[v + 1] = weight;
        rows++;
      }
    }
    return rows;
  }

  private readonly out = new Float64Array(6);

  /** Loads control point `slot` (0..3) from sample offset `at`, or a phantom extrapolated from the segment (a → b) when `at` < 0. */
  private load(slot: number, at: number, a: number, b: number): void {
    const d = this.data, p = this.p;
    for (let c = 0; c < 6; c++) p[slot * 6 + c] = at >= 0 ? d[at + c]! : slot === 0 ? 2 * d[a + c]! - d[b + c]! : 2 * d[b + c]! - d[a + c]!;
  }

  private distance(i: number, j: number): number {
    const p = this.p;
    let sum = 0;
    for (let c = 0; c < 6; c++) { const delta = p[i * 6 + c]! - p[j * 6 + c]!; sum += delta * delta; }
    return Math.sqrt(sum);
  }
}

const VERTEX = /* glsl */`
attribute float aWeight;
varying vec2 vUv;
varying float vWeight;
void main() { vUv = uv; vWeight = aWeight; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Three layers in one strip (uv.x = age 0..1, uv.y = position along the blade, 1 = the edge): a razor-thin
// HDR edge line, a soft saturated body that thins toward the blade root and with age, and a faint wide
// afterglow. Output is premultiplied additive, clamped to the HDR dominant maximum.
const FRAGMENT = /* glsl */`
uniform vec3 uEdge;
uniform vec3 uBody;
uniform vec3 uGlow;
uniform float uIntensity;
uniform float uWidth;
varying vec2 vUv;
varying float vWeight;
void main() {
  float life = clamp(1.0 - vUv.x, 0.0, 1.0);
  float s = vUv.y;
  float ex = (s - 1.0) / (0.028 * uWidth);
  float edge = exp(-ex * ex);
  float body = smoothstep(clamp(1.0 - 0.95 * uWidth, 0.0, 0.6), 1.0, s) * (1.0 - smoothstep(1.0, 1.05, s));
  float gx = (s - 0.95) / (0.5 * uWidth);
  float glow = exp(-gx * gx);
  float fade = life * life * (3.0 - 2.0 * life);
  vec3 color = uEdge * edge * (0.25 + 0.75 * fade) + uBody * body * body * 0.95 * fade * fade + uGlow * glow * 0.55 * fade;
  vec3 emission = clamp(color * vWeight * uIntensity, vec3(0.0), vec3(4.0));
  // Preserve additive RGB on opaque worlds without painting the transparent preview's unlit strip black.
  float coverage = clamp(max(emission.r, max(emission.g, emission.b)), 0.0, 1.0);
  gl_FragColor = vec4(emission, coverage);
}`;

type TrailUniforms = { uEdge: IUniform<Color>; uBody: IUniform<Color>; uGlow: IUniform<Color>; uIntensity: IUniform<number>; uWidth: IUniform<number> };

/**
 * The Warden Blade's swept crescent: three layers (razor edge, soft body, afterglow) over a Catmull-Rom
 * sub-sampled strip of the blade's base→tip chord. One draw call; dies `life` seconds after the last sample.
 */
export class BladeTrailFx {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly sampler = new TrailSampler();
  private readonly uniforms: TrailUniforms = { uEdge: { value: new Color() }, uBody: { value: new Color() }, uGlow: { value: new Color() }, uIntensity: { value: 1 }, uWidth: { value: 1 } };
  private readonly buffers: TrailBuffers;
  private readonly attributes: BufferAttribute[] = [];
  private readonly color = [0, 0, 0];
  private life = 0.16;
  private rows = 0;

  constructor() {
    this.buffers = { positions: new Float32Array(MAX_ROWS * 2 * 3), uvs: new Float32Array(MAX_ROWS * 2 * 2), weights: new Float32Array(MAX_ROWS * 2) };
    const geometry = new BufferGeometry(), index: number[] = [];
    const attribute = (name: string, array: Float32Array, size: number): void => {
      const value = new BufferAttribute(array, size).setUsage(DynamicDrawUsage);
      geometry.setAttribute(name, value);
      this.attributes.push(value);
    };
    attribute('position', this.buffers.positions, 3); attribute('uv', this.buffers.uvs, 2); attribute('aWeight', this.buffers.weights, 1);
    for (let i = 0; i < MAX_ROWS - 1; i++) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);
    const material = new ShaderMaterial({ name: 'vfx-blade-trail', vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms: this.uniforms, transparent: true, depthWrite: false, premultipliedAlpha: true, blending: AdditiveBlending, side: DoubleSide });
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'vfx-blade-trail'; this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 14;
    this.setStyle('arcane', 1, 0.16);
  }

  /** Palette element for edge/body/afterglow, brightness multiplier, visible age of a sample in seconds and strip width scale (1 = default). */
  setStyle(element: VfxElement, intensity: number, life: number, width = 1): void {
    const palette = PALETTE[element];
    this.life = Math.max(0.03, life);
    this.uniforms.uIntensity.value = intensity;
    this.uniforms.uWidth.value = Math.min(2.2, Math.max(0.5, width));
    this.setColor(this.uniforms.uEdge.value, palette.hot.r, palette.hot.g, palette.hot.b);
    this.setColor(this.uniforms.uBody.value, palette.b.r, palette.b.g, palette.b.b);
    this.setColor(this.uniforms.uGlow.value, palette.a.r, palette.a.g, palette.a.b);
  }

  push(bx: number, by: number, bz: number, tx: number, ty: number, tz: number, time: number, weight: number): boolean { return this.sampler.push(bx, by, bz, tx, ty, tz, time, weight); }

  /** Rebuilds the strip for `time` (world seconds); hides the mesh once every sample is older than the trail life. */
  update(time: number): void {
    this.rows = this.sampler.build(time, this.life, this.buffers);
    this.mesh.visible = this.rows >= 2;
    this.mesh.geometry.setDrawRange(0, Math.max(0, this.rows - 1) * 6);
    if (this.rows < 2) return;
    for (const attribute of this.attributes) { attribute.clearUpdateRanges(); attribute.addUpdateRange(0, this.rows * 2 * attribute.itemSize); attribute.needsUpdate = true; }
  }

  clear(): void { this.sampler.clear(); this.rows = 0; this.mesh.visible = false; this.mesh.geometry.setDrawRange(0, 0); }
  get visibleRows(): number { return this.rows; }
  dispose(): void { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }

  private setColor(target: Color, r: number, g: number, b: number): void {
    this.color[0] = r; this.color[1] = g; this.color[2] = b; capHdr(this.color);
    target.setRGB(this.color[0]!, this.color[1]!, this.color[2]!);
  }
}

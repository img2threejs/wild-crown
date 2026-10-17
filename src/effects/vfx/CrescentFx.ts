import { AdditiveBlending, BufferAttribute, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, Quaternion, ShaderMaterial, type IUniform } from 'three';
import { PALETTE, capHdr, type VfxElement } from './palette.js';

const SEGMENTS = 32;
/** Arc span (radians) of the unit crescent; its chord is `CRESCENT_CHORD`. */
export const CRESCENT_SPAN = 2.1;
export const CRESCENT_CHORD = 2 * Math.sin(CRESCENT_SPAN / 2);

const VERTEX = /* glsl */`
uniform float uTime;
attribute vec3 iPos;
attribute vec4 iQuat;
attribute vec4 iShape;
attribute vec4 iTiming;
attribute vec3 iColorA;
attribute vec3 iColorHot;
attribute float aArc;
varying vec2 vUv;
varying float vFade;
varying float vSeed;
varying float vIntensity;
varying vec3 vColorA;
varying vec3 vColorHot;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  float age = uTime - iTiming.x;
  float life = iTiming.y;
  if (life <= 0.0 || age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); vFade = 0.0; vSeed = 0.0; vIntensity = 0.0; vColorA = vec3(0.0); vColorHot = vec3(0.0); return; }
  float prof = pow(max(sin(3.14159265 * uv.x), 0.0), 0.8) + 0.04;
  float radius = mix(1.0 - 0.17 * prof * iShape.y, 1.0, uv.y);
  vec3 local = vec3(sin(aArc) * radius, cos(aArc) * radius - 1.0, 0.0) * iShape.x;
  vec3 world = iPos + qrot(iQuat, local);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vUv = uv;
  vSeed = iShape.z;
  vIntensity = iShape.w;
  vColorA = iColorA;
  vColorHot = iColorHot;
  vFade = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(life - iTiming.z, life, age));
}`;

const FRAGMENT = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying float vFade;
varying float vSeed;
varying float vIntensity;
varying vec3 vColorA;
varying vec3 vColorHot;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float across = clamp(vUv.y, 0.0, 1.0);
  float along = pow(max(sin(3.14159265 * clamp(vUv.x, 0.0, 1.0)), 0.0), 0.55);
  float x = (across - 0.975) / 0.03;
  float line = exp(-x * x);
  float body = across * across * (3.0 - 2.0 * across) * smoothstep(0.0, 0.96, across);
  float streak = 0.5 + 0.5 * noise(vec2(vUv.x * 13.0 - uTime * 6.0 + vSeed * 31.0, across * 3.5));
  vec3 color = (vColorA * body * (0.55 + 0.7 * streak) + vColorHot * line) * vIntensity;
  float alpha = along * (body * 0.5 + line) * vFade;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(clamp(color, vec3(0.0), vec3(4.0)), clamp(alpha, 0.0, 1.0));
}`;

/** Handle into the instance pool. */
export interface CrescentSlot { readonly index: number }

/**
 * Pooled glowing crescent blades in one draw call: thin HDR edge, transparent body with scrolling
 * streaks. Used for the travelling Crescent Wave and the X-shaped Judgement marks. The crescent lies in
 * its local XY plane with the convex edge toward +Y; the caller supplies an orientation quaternion.
 */
export class CrescentFx {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly capacity: number;
  private readonly geometry = new InstancedBufferGeometry();
  private readonly pos: Float32Array;
  private readonly quat: Float32Array;
  private readonly shape: Float32Array;
  private readonly timing: Float32Array;
  private readonly colorA: Float32Array;
  private readonly colorHot: Float32Array;
  private readonly attributes: InstancedBufferAttribute[] = [];
  private readonly owners: Int32Array;
  private readonly ends: Float64Array;
  private readonly uTime: IUniform<number> = { value: 0 };
  private readonly scratch = [0, 0, 0];
  private highWater = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -1;

  constructor(capacity = 24) {
    this.capacity = capacity;
    const positions = new Float32Array((SEGMENTS + 1) * 2 * 3), uvs = new Float32Array((SEGMENTS + 1) * 2 * 2), arcs = new Float32Array((SEGMENTS + 1) * 2), index: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS, theta = -CRESCENT_SPAN / 2 + CRESCENT_SPAN * u;
      uvs.set([u, 0, u, 1], i * 4); arcs[i * 2] = theta; arcs[i * 2 + 1] = theta;
      if (i < SEGMENTS) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    this.geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    this.geometry.setAttribute('aArc', new BufferAttribute(arcs, 1));
    this.geometry.setIndex(index);
    const attribute = (name: string, size: number): Float32Array => {
      const array = new Float32Array(capacity * size), value = new InstancedBufferAttribute(array, size).setUsage(DynamicDrawUsage);
      this.geometry.setAttribute(name, value);
      this.attributes.push(value);
      return array;
    };
    this.pos = attribute('iPos', 3); this.quat = attribute('iQuat', 4); this.shape = attribute('iShape', 4); this.timing = attribute('iTiming', 4);
    this.colorA = attribute('iColorA', 3); this.colorHot = attribute('iColorHot', 3);
    for (let i = 0; i < capacity; i++) this.quat[i * 4 + 3] = 1;
    this.owners = new Int32Array(capacity).fill(-1);
    this.ends = new Float64Array(capacity).fill(-Infinity);
    this.geometry.instanceCount = 0;
    const material = new ShaderMaterial({ name: 'vfx-crescent', vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms: { uTime: this.uTime }, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.name = 'vfx-crescents'; this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 14;
  }

  /**
   * `scale` is the radius in metres (chord = scale × CRESCENT_CHORD); `thickness` multiplies the body width
   * (0.17 of the radius). `fadeOut` is the closing fade in seconds. Returns -1 when the pool is full of
   * unexpired crescents (the newest request is dropped).
   */
  spawn(owner: number, time: number, life: number, x: number, y: number, z: number, orientation: Quaternion, scale: number, thickness: number, intensity: number, fadeOut: number, element: VfxElement, hot: VfxElement | { readonly r: number; readonly g: number; readonly b: number } = element): number {
    if (!Number.isFinite(x + y + z + life + scale + thickness + intensity + time) || !(life > 0)) return -1;
    let index = -1;
    for (let i = 0; i < this.capacity; i++) if (this.ends[i]! <= time) { index = i; break; }
    if (index < 0) return -1;
    this.highWater = Math.max(this.highWater, index + 1);
    this.owners[index] = owner; this.ends[index] = time + life;
    this.pos[index * 3] = x; this.pos[index * 3 + 1] = y; this.pos[index * 3 + 2] = z;
    this.quat[index * 4] = orientation.x; this.quat[index * 4 + 1] = orientation.y; this.quat[index * 4 + 2] = orientation.z; this.quat[index * 4 + 3] = orientation.w;
    this.shape[index * 4] = scale; this.shape[index * 4 + 1] = thickness; this.shape[index * 4 + 2] = (owner * 0.6180339 + index * 0.37) % 1; this.shape[index * 4 + 3] = intensity;
    this.timing[index * 4] = time; this.timing[index * 4 + 1] = life; this.timing[index * 4 + 2] = Math.max(0.02, Math.min(life, fadeOut)); this.timing[index * 4 + 3] = 0;
    const palette = PALETTE[element], hotColor = typeof hot === 'string' ? PALETTE[hot].hot : hot;
    this.scratch[0] = palette.b.r; this.scratch[1] = palette.b.g; this.scratch[2] = palette.b.b; capHdr(this.scratch);
    this.colorA[index * 3] = this.scratch[0]!; this.colorA[index * 3 + 1] = this.scratch[1]!; this.colorA[index * 3 + 2] = this.scratch[2]!;
    this.colorHot[index * 3] = hotColor.r; this.colorHot[index * 3 + 1] = hotColor.g; this.colorHot[index * 3 + 2] = hotColor.b;
    this.markDirty(index);
    return index;
  }

  /** Moves a live crescent (travelling wave). */
  place(index: number, x: number, y: number, z: number): void {
    if (index < 0 || this.ends[index] === -Infinity) return;
    this.pos[index * 3] = x; this.pos[index * 3 + 1] = y; this.pos[index * 3 + 2] = z;
    this.markDirty(index);
  }

  /** Ends a crescent now (its shader fade is skipped; callers spawn the closing effect themselves). */
  release(index: number): void {
    if (index < 0 || this.ends[index] === -Infinity) return;
    this.owners[index] = -1; this.ends[index] = -Infinity; this.timing[index * 4 + 1] = 0;
    this.markDirty(index);
  }

  update(time: number): void {
    this.uTime.value = time;
    this.geometry.instanceCount = this.highWater;
    let live = false;
    for (let i = 0; i < this.highWater; i++) if (this.ends[i]! > time) { live = true; break; }
    this.mesh.visible = live;
    if (this.dirtyMax < this.dirtyMin) return;
    const start = this.dirtyMin, count = this.dirtyMax - this.dirtyMin + 1;
    for (const attribute of this.attributes) { attribute.clearUpdateRanges(); attribute.addUpdateRange(start * attribute.itemSize, count * attribute.itemSize); attribute.needsUpdate = true; }
    this.dirtyMin = Infinity; this.dirtyMax = -1;
  }

  killOwner(owner: number): void { for (let i = 0; i < this.capacity; i++) if (this.owners[i] === owner) this.release(i); }
  clear(): void { for (let i = 0; i < this.capacity; i++) this.release(i); }
  activeCount(time: number): number { let count = 0; for (let i = 0; i < this.capacity; i++) if (this.ends[i]! > time) count++; return count; }
  dispose(): void { this.mesh.removeFromParent(); this.geometry.dispose(); this.mesh.material.dispose(); }

  private markDirty(index: number): void {
    if (index < this.dirtyMin) this.dirtyMin = index;
    if (index > this.dirtyMax) this.dirtyMax = index;
  }
}

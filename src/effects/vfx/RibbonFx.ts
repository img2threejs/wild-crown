import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Group, Mesh, ShaderMaterial, Vector3, type IUniform } from 'three';
import { PALETTE, type VfxElement } from './palette.js';

const NOISE = /* glsl */`
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}`;

type RibbonUniforms = { uTime: IUniform<number>; uAlpha: IUniform<number>; uIntensity: IUniform<number>; uLength: IUniform<number>; uColorA: IUniform<Color>; uColorB: IUniform<Color>; uColorHot: IUniform<Color> };
function ribbonUniforms(): RibbonUniforms {
  return { uTime: { value: 0 }, uAlpha: { value: 0 }, uIntensity: { value: 1 }, uLength: { value: 1 }, uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorHot: { value: new Color() } };
}
/** Body (a → b) plus thin hot core, straight from the element palette. */
function applyPalette(uniforms: RibbonUniforms, element: VfxElement): void {
  const palette = PALETTE[element];
  uniforms.uColorA.value.copy(palette.a); uniforms.uColorB.value.copy(palette.b); uniforms.uColorHot.value.copy(palette.hot);
}
function ribbonMaterial(name: string, fragment: string, uniforms: RibbonUniforms, vertex = BASIC_VERTEX): ShaderMaterial {
  return new ShaderMaterial({ name, vertexShader: vertex, fragmentShader: fragment, uniforms, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide });
}
const BASIC_VERTEX = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Ribbons draw a saturated body; only a thin centre line may carry the hot core colour. All pow()
// bases are clamped non-negative and the result is clamped to the HDR dominant maximum.
const BLADE_FRAGMENT = /* glsl */`
uniform float uTime; uniform float uAlpha; uniform float uIntensity; uniform vec3 uColorA; uniform vec3 uColorB; uniform vec3 uColorHot;
varying vec2 vUv;
${NOISE}
void main() {
  float along = pow(max(sin(3.14159 * clamp(vUv.x, 0.0, 1.0)), 0.0), 0.6);
  float edge = smoothstep(0.0, 0.45, vUv.y) * (1.0 - smoothstep(0.82, 1.0, vUv.y));
  float streak = 0.5 + 0.5 * noise(vec2(vUv.x * 12.0 - uTime * 7.0, vUv.y * 3.0));
  float core = smoothstep(0.55, 0.95, vUv.y);
  float line = smoothstep(0.82, 0.9, vUv.y) * (1.0 - smoothstep(0.9, 0.98, vUv.y));
  vec3 color = (mix(uColorA, uColorB, core) * (0.7 + 0.5 * core) + uColorHot * line * 0.35) * uIntensity;
  float alpha = along * edge * streak * uAlpha;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(clamp(color, vec3(0.0), vec3(4.0)), clamp(alpha, 0.0, 1.0));
}`;

const BEAM_FRAGMENT = /* glsl */`
uniform float uTime; uniform float uAlpha; uniform float uIntensity; uniform float uLength; uniform vec3 uColorA; uniform vec3 uColorB; uniform vec3 uColorHot;
varying vec2 vUv;
${NOISE}
void main() {
  float across = clamp(1.0 - abs(vUv.y * 2.0 - 1.0), 0.0, 1.0);
  float n = noise(vec2(vUv.x * uLength * 1.6 - uTime * 4.0, vUv.y * 2.5)) * 0.65 + noise(vec2(vUv.x * uLength * 4.0 - uTime * 7.0, vUv.y * 5.0)) * 0.35;
  float ends = smoothstep(0.0, 0.06, vUv.x) * (1.0 - smoothstep(0.94, 1.0, vUv.x));
  float a2 = across * across, a4 = a2 * a2;
  float thread = a4 * a4 * smoothstep(0.55, 0.85, n);
  vec3 color = (mix(uColorA, uColorB, across) * (0.55 + 0.6 * n) + uColorHot * thread * 0.4) * uIntensity;
  float alpha = across * sqrt(across) * (0.45 + 0.55 * n) * ends * uAlpha;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(clamp(color, vec3(0.0), vec3(4.0)), clamp(alpha, 0.0, 1.0));
}`;

const BLADE_SEGMENTS = 28;
/** Unit crescent in XZ: apex at the origin, convex side toward +Z, chord along X. */
const BLADE_SPAN = 2.1;
export const BLADE_CHORD = 2 * Math.sin(BLADE_SPAN / 2);
function crescentGeometry(): BufferGeometry {
  const positions = new Float32Array((BLADE_SEGMENTS + 1) * 2 * 3), uvs = new Float32Array((BLADE_SEGMENTS + 1) * 2 * 2), index: number[] = [];
  for (let i = 0; i <= BLADE_SEGMENTS; i++) {
    const u = i / BLADE_SEGMENTS, theta = -BLADE_SPAN / 2 + BLADE_SPAN * u;
    const width = 0.17 * Math.pow(Math.sin(Math.PI * u), 0.8) + 0.008, lift = 0.12 * Math.pow(Math.abs(u * 2 - 1), 2);
    positions.set([(1 - width) * Math.sin(theta), lift, (1 - width) * Math.cos(theta) - 1, Math.sin(theta), lift, Math.cos(theta) - 1], i * 6);
    uvs.set([u, 0, u, 1], i * 4);
    if (i < BLADE_SEGMENTS) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}

export interface BladeSlot {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly uniforms: RibbonUniforms;
  readonly from: Vector3;
  readonly to: Vector3;
  active: boolean; owner: number; start: number; life: number; scale: number;
}

/** Crescent wind blades flying a straight path with a scrolling alpha streak. */
export class WindBladesFx {
  readonly group = new Group();
  private readonly geometry = crescentGeometry();
  private readonly slots: BladeSlot[] = [];

  constructor(count = 10) {
    this.group.name = 'vfx-wind-blades';
    for (let i = 0; i < count; i++) {
      const uniforms = ribbonUniforms();
      const mesh = new Mesh(this.geometry, ribbonMaterial('vfx-wind-blade', BLADE_FRAGMENT, uniforms));
      mesh.name = 'vfx-wind-blade'; mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 13;
      this.group.add(mesh);
      this.slots.push({ mesh, uniforms, from: new Vector3(), to: new Vector3(), active: false, owner: -1, start: 0, life: 1, scale: 1 });
    }
  }

  /** `chord` is the blade width in metres; yaw orients the convex edge along travel. */
  spawn(from: Vector3, to: Vector3, chord: number, yaw: number, start: number, life: number, owner: number, element: VfxElement = 'wind'): void {
    let slot = this.slots.find(candidate => !candidate.active);
    if (!slot) for (const candidate of this.slots) if (!slot || candidate.start < slot.start) slot = candidate;
    if (!slot) return;
    slot.active = true; slot.owner = owner; slot.start = start; slot.life = life; slot.scale = chord / BLADE_CHORD;
    slot.from.copy(from); slot.to.copy(to);
    slot.mesh.rotation.set(-0.12, yaw, 0);
    slot.mesh.scale.set(slot.scale, slot.scale, slot.scale * 0.75);
    applyPalette(slot.uniforms, element);
    slot.uniforms.uAlpha.value = 0;
    slot.mesh.position.copy(from);
    slot.mesh.visible = false;
  }

  update(time: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const age = time - slot.start;
      if (age >= slot.life) { this.releaseSlot(slot); continue; }
      slot.mesh.visible = age >= 0;
      if (age < 0) continue;
      const t = age / slot.life;
      slot.mesh.position.lerpVectors(slot.from, slot.to, t);
      slot.uniforms.uTime.value = time;
      slot.uniforms.uAlpha.value = Math.pow(Math.sin(Math.PI * t), 0.5);
    }
  }

  killOwner(owner: number): void { for (const slot of this.slots) if (slot.active && slot.owner === owner) this.releaseSlot(slot); }
  clear(): void { for (const slot of this.slots) this.releaseSlot(slot); }
  get activeCount(): number { let count = 0; for (const slot of this.slots) if (slot.active) count++; return count; }
  dispose(): void { this.group.removeFromParent(); this.geometry.dispose(); for (const slot of this.slots) slot.mesh.material.dispose(); }
  private releaseSlot(slot: BladeSlot): void { slot.active = false; slot.owner = -1; slot.mesh.visible = false; }
}

const BEAM_SEGMENTS = 20;
export interface BeamSlot {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly uniforms: RibbonUniforms;
  readonly a: Vector3;
  readonly b: Vector3;
  readonly positions: BufferAttribute;
  readonly array: Float32Array;
  active: boolean; owner: number; start: number; life: number; width: number; wobble: number; alpha: number;
}

/** Camera-facing strips between two points (vines, lanes of light) with scrolling noise. */
export class BeamsFx {
  readonly group = new Group();
  private readonly slots: BeamSlot[] = [];
  private readonly dir = new Vector3();
  private readonly side = new Vector3();
  private readonly view = new Vector3();
  private readonly up = new Vector3();
  private readonly point = new Vector3();

  constructor(count = 8) {
    this.group.name = 'vfx-beams';
    for (let i = 0; i < count; i++) {
      const geometry = new BufferGeometry();
      const array = new Float32Array((BEAM_SEGMENTS + 1) * 2 * 3);
      const positions = new BufferAttribute(array, 3).setUsage(DynamicDrawUsage);
      const uvs = new Float32Array((BEAM_SEGMENTS + 1) * 2 * 2), index: number[] = [];
      for (let s = 0; s <= BEAM_SEGMENTS; s++) {
        uvs.set([s / BEAM_SEGMENTS, 0, s / BEAM_SEGMENTS, 1], s * 4);
        if (s < BEAM_SEGMENTS) index.push(s * 2, s * 2 + 1, s * 2 + 2, s * 2 + 1, s * 2 + 3, s * 2 + 2);
      }
      geometry.setAttribute('position', positions);
      geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
      geometry.setIndex(index);
      const uniforms = ribbonUniforms();
      const mesh = new Mesh(geometry, ribbonMaterial('vfx-beam', BEAM_FRAGMENT, uniforms));
      mesh.name = 'vfx-beam'; mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 13;
      this.group.add(mesh);
      this.slots.push({ mesh, uniforms, a: new Vector3(), b: new Vector3(), positions, array, active: false, owner: -1, start: 0, life: Infinity, width: 0.2, wobble: 0, alpha: 1 });
    }
  }

  /** `life` ≤ 0 keeps the beam until `release`; endpoints may be moved every frame. */
  acquire(owner: number, start: number, life: number, width: number, wobble: number, element: VfxElement): BeamSlot | undefined {
    let slot = this.slots.find(candidate => !candidate.active);
    if (!slot) for (const candidate of this.slots) if (candidate.life !== Infinity && (!slot || candidate.start < slot.start)) slot = candidate;
    if (!slot) return undefined;
    slot.active = true; slot.owner = owner; slot.start = start; slot.life = life > 0 ? life : Infinity; slot.width = width; slot.wobble = wobble; slot.alpha = 1;
    applyPalette(slot.uniforms, element);
    return slot;
  }

  release(slot: BeamSlot): void { slot.active = false; slot.owner = -1; slot.mesh.visible = false; }

  update(time: number, camera: Vector3): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const age = time - slot.start;
      if (age >= slot.life) { this.release(slot); continue; }
      const length = this.dir.subVectors(slot.b, slot.a).length();
      if (length < 1e-3) { slot.mesh.visible = false; continue; }
      this.dir.multiplyScalar(1 / length);
      this.view.subVectors(camera, this.point.addVectors(slot.a, slot.b).multiplyScalar(0.5)).normalize();
      this.side.crossVectors(this.dir, this.view);
      if (this.side.lengthSq() < 1e-6) this.side.set(1, 0, 0);
      this.side.normalize();
      this.up.crossVectors(this.side, this.dir).normalize();
      const array = slot.array;
      for (let s = 0; s <= BEAM_SEGMENTS; s++) {
        const u = s / BEAM_SEGMENTS, envelope = Math.sin(Math.PI * u);
        const sway = slot.wobble * envelope * Math.sin(u * Math.PI * 3 + time * 5);
        const lift = slot.wobble * 0.6 * envelope * Math.cos(u * Math.PI * 2 - time * 3.5);
        this.point.lerpVectors(slot.a, slot.b, u).addScaledVector(this.side, sway).addScaledVector(this.up, lift);
        const half = slot.width * (0.55 + 0.45 * envelope);
        array[s * 6] = this.point.x - this.side.x * half; array[s * 6 + 1] = this.point.y - this.side.y * half; array[s * 6 + 2] = this.point.z - this.side.z * half;
        array[s * 6 + 3] = this.point.x + this.side.x * half; array[s * 6 + 4] = this.point.y + this.side.y * half; array[s * 6 + 5] = this.point.z + this.side.z * half;
      }
      slot.positions.needsUpdate = true;
      const fade = slot.life === Infinity ? 1 : Math.min(1, age / 0.08) * Math.min(1, (slot.life - age) / 0.15);
      slot.uniforms.uTime.value = time; slot.uniforms.uLength.value = length; slot.uniforms.uAlpha.value = fade * slot.alpha;
      slot.mesh.visible = true;
    }
  }

  killOwner(owner: number): void { for (const slot of this.slots) if (slot.active && slot.owner === owner) this.release(slot); }
  clear(): void { for (const slot of this.slots) this.release(slot); }
  get activeCount(): number { let count = 0; for (const slot of this.slots) if (slot.active) count++; return count; }
  dispose(): void { this.group.removeFromParent(); for (const slot of this.slots) { slot.mesh.geometry.dispose(); slot.mesh.material.dispose(); } }
}

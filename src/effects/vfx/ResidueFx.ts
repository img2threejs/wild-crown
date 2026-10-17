import { DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix3, Matrix4, Object3D, PlaneGeometry, Quaternion, ShaderMaterial, Vector3 } from 'three';
import type { StoryCue } from '../story-cues.js';
import { PALETTE } from './palette.js';

const CAPACITY = 28;
const REDUCED_CAPACITY = 8;
const FRONT = new Vector3(0, 0, 1);
const VERTEX = /* glsl */`
  attribute vec4 residueData;
  attribute vec3 residueColor;
  varying vec2 vUv;
  varying vec4 vData;
  varying vec3 vColor;
  void main() {
    vUv = uv; vData = residueData; vColor = residueColor;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;
const FRAGMENT = /* glsl */`
  uniform float time;
  varying vec2 vUv;
  varying vec4 vData;
  varying vec3 vColor;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    float age = time - vData.x;
    float fade = smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(vData.y * 0.55, vData.y, age));
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.y, p.x) + vData.w;
    float edge = 0.74 + 0.08 * sin(a * 7.0 + sin(a * 3.0));
    float mask = 1.0 - smoothstep(edge - 0.22, edge, r);
    float grit = hash(floor(p * 42.0) + vData.w);
    float split = abs(sin(a * 4.0 + sin(r * 19.0 + vData.w) * 0.28));
    float cracks = (1.0 - smoothstep(0.025, 0.09, split)) * smoothstep(0.09, 0.24, r);
    float cut = exp(-abs(p.y + sin(p.x * 8.0 + vData.w) * 0.025) * 56.0) * (1.0 - smoothstep(0.4, 0.85, abs(p.x)));
    float glow = max(cracks * 0.65, cut) * exp(-age * 0.65);
    float alpha = mask * (0.14 + grit * 0.2 + glow * 0.66) * fade * vData.z;
    if (alpha < 0.005) discard;
    gl_FragColor = vec4(mix(vec3(0.045, 0.029, 0.023), vColor, clamp(glow * 1.6, 0.0, 1.0)), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

interface ResidueSlot {
  active: boolean;
  owner: number;
  start: number;
  life: number;
  size: number;
  actorId?: string;
  root?: Object3D;
  readonly point: Vector3;
  readonly normal: Vector3;
}

/** One draw call, a fixed pool, and only engine-confirmed contacts. Actor marks retain the contact in root-local space. */
export class ResidueFx {
  readonly group = new Group();
  readonly mesh: InstancedMesh<PlaneGeometry, ShaderMaterial>;
  private readonly slots: ResidueSlot[] = [];
  private readonly data = new InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4).setUsage(DynamicDrawUsage);
  private readonly colors = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(DynamicDrawUsage);
  private readonly matrix = new Matrix4();
  private readonly inverse = new Matrix4();
  private readonly normalMatrix = new Matrix3();
  private readonly position = new Vector3();
  private readonly normal = new Vector3();
  private readonly scale = new Vector3();
  private readonly rotation = new Quaternion();
  private reduced = false;
  private serial = 0;

  constructor(private readonly clock: { readonly time: number }, private readonly resolveRoot?: (id: string) => Object3D | undefined) {
    const geometry = new PlaneGeometry(1, 1);
    geometry.setAttribute('residueData', this.data);
    geometry.setAttribute('residueColor', this.colors);
    const material = new ShaderMaterial({ name: 'contact-residue', vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms: { time: { value: 0 } }, transparent: true, depthWrite: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.mesh = new InstancedMesh(geometry, material, CAPACITY);
    this.mesh.name = 'vfx-contact-residue';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.group.name = 'vfx-residue';
    this.group.add(this.mesh);
    this.matrix.makeScale(0, 0, 0);
    for (let i = 0; i < CAPACITY; i++) {
      this.slots.push({ active: false, owner: 0, start: 0, life: 0, size: 0, point: new Vector3(), normal: new Vector3() });
      this.mesh.setMatrixAt(i, this.matrix);
    }
  }

  setReducedEffects(reduced: boolean): void {
    this.reduced = reduced;
    if (reduced) for (let i = REDUCED_CAPACITY; i < CAPACITY; i++) this.release(i);
  }

  emit(cue: StoryCue, owner: number): boolean {
    const contact = cue.contact, at = cue.position;
    if (!contact || !at || cue.actorId !== 'aren') return false;
    const actor = contact.kind === 'actor';
    if (actor ? cue.kind !== 'hit' || !(cue.confirmedDamage! > 0) || !cue.targetId : cue.kind !== 'projectile-impact') return false;
    const root = actor && cue.targetId ? this.resolveRoot?.(cue.targetId) : undefined;
    if (actor && (!root || !root.visible)) return false;
    this.normal.set(contact.normal.x, contact.normal.y, contact.normal.z);
    if (this.normal.lengthSq() < 1e-8) return false;
    this.normal.normalize();
    const limit = this.reduced ? REDUCED_CAPACITY : CAPACITY;
    let index = 0;
    for (let i = 0; i < limit; i++) {
      if (!this.slots[i]!.active) { index = i; break; }
      if (this.slots[i]!.start < this.slots[index]!.start) index = i;
    }
    const slot = this.slots[index]!;
    slot.active = true; slot.owner = owner; slot.start = this.clock.time - 0.025;
    slot.life = actor ? 1.8 : 4.8;
    slot.size = actor ? Math.min(0.8, 0.28 + cue.confirmedDamage! / 80) : Math.min(1.2, 0.45 + (cue.intensity ?? 1) * 0.24);
    slot.actorId = actor ? cue.targetId : undefined;
    slot.root = root;
    slot.point.set(at.x, at.y, at.z).addScaledVector(this.normal, 0.012);
    slot.normal.copy(this.normal);
    if (root) {
      root.updateWorldMatrix(true, false);
      this.inverse.copy(root.matrixWorld).invert();
      slot.point.applyMatrix4(this.inverse);
      slot.normal.applyNormalMatrix(this.normalMatrix.getNormalMatrix(this.inverse));
    }
    const tint = PALETTE[cue.element ?? 'earth'].b;
    this.colors.setXYZ(index, tint.r, tint.g, tint.b);
    this.data.setXYZW(index, slot.start, slot.life, this.reduced ? 0.55 : 0.88, (++this.serial % 101) * 0.73);
    this.colors.needsUpdate = this.data.needsUpdate = true;
    this.place(index, slot);
    this.mesh.material.uniforms.time!.value = this.clock.time;
    this.mesh.visible = true;
    return true;
  }

  update(time: number): void {
    this.mesh.material.uniforms.time!.value = time;
    let visible = false;
    for (let i = 0; i < CAPACITY; i++) {
      const slot = this.slots[i]!;
      if (!slot.active) continue;
      if (time - slot.start >= slot.life || slot.root && (!slot.root.visible || this.resolveRoot?.(slot.actorId!) !== slot.root)) { this.release(i); continue; }
      if (slot.root) this.place(i, slot);
      visible = true;
    }
    this.mesh.visible = visible;
  }

  killOwner(owner: number): void { for (let i = 0; i < CAPACITY; i++) if (this.slots[i]!.active && this.slots[i]!.owner === owner) this.release(i); }
  clear(): void { for (let i = 0; i < CAPACITY; i++) this.release(i); this.mesh.visible = false; }
  get activeCount(): number { let count = 0; for (const slot of this.slots) if (slot.active) count++; return count; }
  dispose(): void { this.clear(); this.group.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose(); }

  private place(index: number, slot: ResidueSlot): void {
    this.position.copy(slot.point); this.normal.copy(slot.normal);
    if (slot.root) {
      slot.root.updateWorldMatrix(true, false);
      this.position.applyMatrix4(slot.root.matrixWorld);
      this.normal.applyNormalMatrix(this.normalMatrix.getNormalMatrix(slot.root.matrixWorld));
    }
    this.rotation.setFromUnitVectors(FRONT, this.normal);
    this.scale.set(slot.size, slot.size, 1);
    this.matrix.compose(this.position, this.rotation, this.scale);
    this.mesh.setMatrixAt(index, this.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  private release(index: number): void {
    const slot = this.slots[index]!;
    if (!slot.active) return;
    slot.active = false; slot.root = undefined; slot.actorId = undefined;
    this.matrix.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(index, this.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

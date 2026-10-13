import { Color, Mesh, ShaderMaterial, SkinnedMesh, Vector3, type IUniform, type Object3D } from 'three';
import { PALETTE } from './palette.js';
import type { VfxSystem } from './VfxSystem.js';

/** Seconds the corruption shell takes to burn away. */
export const DISSOLVE_SECONDS = 1.6;
const MAX_SLOTS = 3;
const INFLATE = 0.025;
const ASH = new Color().setRGB(0.12, 0.1, 0.095);

const VERTEX = /* glsl */`
uniform float uInflate;
varying vec3 vObj;
varying vec3 vNormalView;
varying vec3 vViewPos;
#include <common>
#include <skinning_pars_vertex>
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vObj = position;
  vec3 n = objectNormal;
  float nl = length(n);
  if (nl > 1e-5) transformed += (n / nl) * uInflate;
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
  vNormalView = normalize(normalMatrix * (nl > 1e-5 ? n / nl : vec3(0.0, 1.0, 0.0)));
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

// Corruption burn: a black-sap shell whose 3D noise field (stretched along the body axis, like the reference's
// ember streaks) is eaten away by a rising threshold. The burning rim glows ember orange (HDR), the remaining
// shell stays dark with a faint violet fresnel. Everything is finite for every input.
const FRAGMENT = /* glsl */`
uniform float uProgress;
uniform float uTime;
uniform float uFreq;
uniform float uHeightInv;
uniform vec3 uShell;
uniform vec3 uSheen;
uniform vec3 uEmber;
uniform vec3 uHot;
varying vec3 vObj;
varying vec3 vNormalView;
varying vec3 vViewPos;
float hash3(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y);
  float b = mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y);
  return mix(a, b, f.z);
}
float fbm3(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise3(p); p = p * 2.02 + 11.7; a *= 0.5; } return v; }
void main() {
  vec3 q = vec3(vObj.x * uFreq, vObj.y * uFreq * 0.32, vObj.z * uFreq);
  float n = fbm3(q);
  float h = clamp(vObj.y * uHeightInv, 0.0, 1.0);
  float field = n * 0.78 + (1.0 - h) * 0.22;
  const float edgeWidth = 0.1;
  float d = field - uProgress * (1.0 + edgeWidth);
  if (d < 0.0) discard;
  float rim = 1.0 - smoothstep(0.0, edgeWidth, d);
  float flicker = 0.85 + 0.15 * sin(uTime * 23.0 + n * 40.0);
  float facing = abs(dot(normalize(vNormalView), normalize(-vViewPos)));
  float fresnel = pow(1.0 - clamp(facing, 0.0, 1.0), 3.0);
  vec3 shell = uShell * (0.55 + 0.7 * n) + uSheen * fresnel;
  vec3 ember = mix(uEmber, uHot, rim * rim) * rim * flicker * 1.15;
  gl_FragColor = vec4(clamp(shell + ember, vec3(0.0), vec3(4.0)), 1.0);
}`;

type DissolveUniforms = {
  uInflate: IUniform<number>; uProgress: IUniform<number>; uTime: IUniform<number>; uFreq: IUniform<number>; uHeightInv: IUniform<number>;
  uShell: IUniform<Color>; uSheen: IUniform<Color>; uEmber: IUniform<Color>; uHot: IUniform<Color>;
};

interface Shell { readonly mesh: Mesh; readonly source: Mesh }
export interface DissolveSlot {
  active: boolean;
  actorId: string;
  owner: number;
  start: number;
  height: number;
  radius: number;
  readonly material: ShaderMaterial;
  readonly uniforms: DissolveUniforms;
  readonly shells: Shell[];
  target: Object3D | undefined;
  emberAcc: number;
  ashAcc: number;
  lastTime: number;
}

/**
 * Cleansed finish: the monster's own meshes stay untouched while a second, slightly inflated black-sap
 * shell (same geometry, same skeleton) burns away through a 3D-noise threshold with a glowing ember rim.
 * The animal is cleansed, not destroyed: only the shell and its materials are created and disposed here.
 */
export class CleanseDissolveFx {
  private readonly slots: DissolveSlot[] = [];
  private readonly scratch = new Vector3();

  constructor(private readonly vfx: VfxSystem) {
    for (let i = 0; i < MAX_SLOTS; i++) {
      const uniforms: DissolveUniforms = {
        uInflate: { value: INFLATE }, uProgress: { value: 0 }, uTime: { value: 0 }, uFreq: { value: 3.2 }, uHeightInv: { value: 1 },
        uShell: { value: new Color().setRGB(0.028, 0.02, 0.04) }, uSheen: { value: new Color().setRGB(0.1, 0.05, 0.22) },
        uEmber: { value: PALETTE.fire.b.clone() }, uHot: { value: PALETTE.fire.hot.clone() },
      };
      const material = new ShaderMaterial({ name: 'vfx-cleanse-dissolve', vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms });
      this.slots.push({ active: false, actorId: '', owner: -1, start: 0, height: 1.2, radius: 0.8, material, uniforms, shells: [], target: undefined, emberAcc: 0, ashAcc: 0, lastTime: 0 });
    }
  }

  /** True while a shell burns on this actor. */
  isActive(actorId: string): boolean { return this.slots.some(slot => slot.active && slot.actorId === actorId); }
  get activeCount(): number { let count = 0; for (const slot of this.slots) if (slot.active) count++; return count; }

  /**
   * Wraps every mesh under `root` in a burning shell. Returns false when no pooled slot is free, the actor is
   * already burning, or the root has no mesh to wrap.
   */
  start(actorId: string, root: Object3D, time: number, owner: number, height: number, radius: number): boolean {
    if (this.isActive(actorId)) return false;
    const slot = this.slots.find(candidate => !candidate.active);
    if (!slot) return false;
    this.attach(slot, root);
    if (slot.shells.length === 0) return false;
    slot.active = true; slot.actorId = actorId; slot.owner = owner; slot.start = time; slot.lastTime = time; slot.target = root;
    slot.height = Math.max(0.4, height); slot.radius = Math.max(0.3, radius); slot.emberAcc = 0; slot.ashAcc = 0;
    slot.uniforms.uProgress.value = 0; slot.uniforms.uHeightInv.value = 1 / slot.height;
    return true;
  }

  /**
   * Compiles the skinned shell program ahead of the first cleanse: wears a shell on every root for one `compile()` call
   * (a full-scene compile such as `GameRenderer.prewarm`) and removes it again. No-op while a dissolve is running.
   */
  prewarm(roots: readonly Object3D[], compile: () => void): void {
    const slot = this.slots[0];
    if (!slot || this.activeCount > 0) return;
    for (const root of roots) this.attach(slot, root);
    try { if (slot.shells.length > 0) compile(); } finally { this.release(slot); }
  }

  /** Adds one inflated twin of every visible mesh under `root` (sharing geometry, skeleton and the slot material). */
  private attach(slot: DissolveSlot, root: Object3D): void {
    root.traverse(node => {
      if (!(node instanceof Mesh) || !node.parent || !node.visible || node.name.startsWith('vfx-')) return;
      let shell: Mesh;
      if (node instanceof SkinnedMesh) {
        const skinned = new SkinnedMesh(node.geometry, slot.material);
        skinned.bind(node.skeleton, node.bindMatrix);
        skinned.bindMode = node.bindMode;
        shell = skinned;
      } else shell = new Mesh(node.geometry, slot.material);
      shell.name = 'vfx-cleanse-shell';
      shell.frustumCulled = false; shell.castShadow = false; shell.receiveShadow = false; shell.renderOrder = node.renderOrder + 1;
      shell.position.copy(node.position); shell.quaternion.copy(node.quaternion); shell.scale.copy(node.scale);
      node.parent.add(shell);
      slot.shells.push({ mesh: shell, source: node });
    });
  }

  /** Advances every burning shell on the world clock and emits rising embers and ash around the body. */
  update(time: number): void {
    const vfx = this.vfx;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const age = time - slot.start, t = Math.min(1, Math.max(0, age / DISSOLVE_SECONDS)), dt = Math.max(0, Math.min(0.1, time - slot.lastTime));
      slot.lastTime = time;
      if (t >= 1) { this.release(slot); continue; }
      slot.uniforms.uProgress.value = Math.pow(t, 0.92);
      slot.uniforms.uTime.value = time;
      for (const shell of slot.shells) { shell.mesh.position.copy(shell.source.position); shell.mesh.quaternion.copy(shell.source.quaternion); shell.mesh.scale.copy(shell.source.scale); }
      const rootPosition = slot.target ? slot.target.getWorldPosition(this.scratch) : this.scratch;
      const activity = Math.sin(Math.PI * Math.min(1, t * 1.05)) * (vfx.reducedEffects ? 0.35 : 1);
      slot.emberAcc += dt * 110 * activity; slot.ashAcc += dt * 34 * activity;
      for (; slot.emberAcc >= 1; slot.emberAcc--) vfx.embers(rootPosition.x + vfx.range(-1, 1) * slot.radius * 0.8, rootPosition.y + vfx.random() * slot.height * 0.9, rootPosition.z + vfx.range(-1, 1) * slot.radius * 0.8, 1, 0.1, 1.5, -1.1, slot.owner);
      for (; slot.ashAcc >= 1; slot.ashAcc--) vfx.smoke(rootPosition.x + vfx.range(-1, 1) * slot.radius * 0.7, rootPosition.y + vfx.random() * slot.height, rootPosition.z + vfx.range(-1, 1) * slot.radius * 0.7, 1, 0.1, 0.6, 0.3, 1.3, ASH, 0.4, slot.owner, 0.08);
    }
  }


  cancel(actorId: string): void { for (const slot of this.slots) if (slot.active && slot.actorId === actorId) this.release(slot); }
  killOwner(owner: number): void { for (const slot of this.slots) if (slot.active && slot.owner === owner) this.release(slot); }
  clear(): void { for (const slot of this.slots) if (slot.active) this.release(slot); }

  /** Removes every shell (materials are kept for reuse until `dispose`). */
  private release(slot: DissolveSlot): void {
    for (const shell of slot.shells) shell.mesh.removeFromParent();
    slot.shells.length = 0;
    slot.active = false; slot.actorId = ''; slot.owner = -1; slot.target = undefined;
  }

  dispose(): void {
    this.clear();
    for (const slot of this.slots) slot.material.dispose();
    this.slots.length = 0;
  }
}

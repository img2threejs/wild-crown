import { AdditiveBlending, Color, DoubleSide, Group, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Vector3, type DataTexture, type IUniform } from 'three';
import { createEmberRuneTexture, createHeartrootRuneTexture, createRuneTexture, createUmbralRuneTexture } from './RuneTexture.js';
import { PALETTE, type VfxElement } from './palette.js';

// vFacing: |cos| between the quad normal and the view ray. A disc seen near edge-on packs its strokes into a
// thin ellipse, so the fragment shader dims it there instead of letting the overlap bloom into a white slab.
const VERTEX = /* glsl */`
varying vec2 vUv;
varying float vFacing;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFacing = abs(dot(normalize(normalMatrix * vec3(0.0, 0.0, 1.0)), normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}`;

// Three counter-rotating layers sampled from one rune texture (R outer ring + glyph band, G middle
// hexagram, B inner crescent). Every channel is a thin line mask, so the HDR colour only lives on thin
// strokes (bloom picks them up) and the disc interior stays transparent like the reference sigil.
const FRAGMENT = /* glsl */`
uniform sampler2D uTex;
uniform float uAlpha;
uniform float uIntensity;
uniform float uFlash;
uniform float uOuterOnly;
uniform vec3 uAngles;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorHot;
varying vec2 vUv;
varying float vFacing;
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r >= 1.0) discard;
  float outer = texture2D(uTex, rot(p, uAngles.x) * 0.5 + 0.5).r;
  float mid = texture2D(uTex, rot(p, uAngles.y) * 0.5 + 0.5).g * (1.0 - uOuterOnly);
  float inner = texture2D(uTex, rot(p, uAngles.z) * 0.5 + 0.5).b * (1.0 - uOuterOnly);
  float x = (r - 0.985) / 0.03;
  float rim = exp(-x * x);
  float fill = exp(-r * r * 3.2) * 0.1 * (1.0 - uOuterOnly);
  float flash = uFlash * exp(-r * r * 5.0);
  vec3 color = uColorA * outer * 1.05 + uColorB * (mid * 1.15 + inner * 1.25) + uColorHot * (inner * 0.3 + outer * 0.12 + rim * 0.3) + uColorB * fill + uColorHot * flash * 0.7;
  float edge = 1.0 - smoothstep(0.93, 1.0, r);
  // Hue-preserving HDR ceiling: strokes stay above the bloom threshold (1.0) but keep their colour instead of
  // clipping to white when the flare, the fan of sigils and the foreshortening stack up.
  vec3 lit = color * uIntensity * (0.3 + 0.7 * smoothstep(0.12, 0.6, vFacing));
  lit *= min(1.0, 1.8 / max(max(lit.r, max(lit.g, lit.b)), 1e-4));
  gl_FragColor = vec4(lit, clamp(uAlpha * edge, 0.0, 1.0));
}`;

type SigilUniforms = {
  uTex: IUniform<DataTexture>; uAlpha: IUniform<number>; uIntensity: IUniform<number>; uFlash: IUniform<number>; uOuterOnly: IUniform<number>;
  uAngles: IUniform<Vector3>; uColorA: IUniform<Color>; uColorB: IUniform<Color>; uColorHot: IUniform<Color>;
};

/** vertical: a rune circle facing the aim; ground: a flat circle under the caster; shatter: a fast expanding, outer-ring-only burst. */
export type SigilMode = 'vertical' | 'ground' | 'shatter';

export interface SigilSlot {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  readonly uniforms: SigilUniforms;
  readonly center: Vector3;
  readonly normal: Vector3;
  active: boolean;
  owner: number;
  mode: SigilMode;
  start: number;
  /** Seconds until the charge peaks (launch); Infinity = sustained charge that keeps growing. */
  ramp: number;
  /** World time `finish` was called, or Infinity while still charging. */
  finishedAt: number;
  fadeSeconds: number;
  radius: number;
  intensity: number;
  seed: number;
}

/** Back-ease overshoot constant for the spawn pop (≈ 10 % overshoot). */
const OVERSHOOT = 1.70158;

/** Readability limits of a sigil disc near combatants: it never grows past this radius (m) and no stroke or core is lit beyond these levels, so it cannot saturate to a white disc over Aren and his target. */
const SIGIL_RADIUS_MAX = 1.1, SIGIL_INTENSITY_MAX = 1.5, SIGIL_FLASH_MAX = 0.3;
/**
 * Pooled rune magic circles. One draw call per visible sigil: a single quad whose shader rotates three
 * layers of one procedural texture in opposite directions. Time is the authoritative world clock.
 */
export class SigilFx {
  readonly group = new Group();
  readonly texture: DataTexture = createRuneTexture();
  /** Botanical glyph set for Heartroot sigils, created on first use. */
  private heartrootTexture: DataTexture | undefined;
  /** Umbral (blade/crescent) and ember (flame/fist) glyph sets, created on first use. */
  private umbralTexture: DataTexture | undefined;
  private emberTexture: DataTexture | undefined;
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly slots: SigilSlot[] = [];
  private readonly up = new Vector3(0, 1, 0);
  private readonly right = new Vector3();
  private readonly top = new Vector3();
  private readonly basis = new Matrix4();

  constructor(count = 8) {
    this.group.name = 'vfx-sigils';
    for (let i = 0; i < count; i++) {
      const uniforms: SigilUniforms = {
        uTex: { value: this.texture }, uAlpha: { value: 0 }, uIntensity: { value: 1 }, uFlash: { value: 0 }, uOuterOnly: { value: 0 }, uAngles: { value: new Vector3() },
        uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorHot: { value: new Color() },
      };
      const material = new ShaderMaterial({ name: 'vfx-sigil', vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide });
      const mesh = new Mesh(this.geometry, material);
      mesh.name = 'vfx-sigil'; mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 15;
      this.group.add(mesh);
      this.slots.push({ mesh, uniforms, center: new Vector3(), normal: new Vector3(0, 0, 1), active: false, owner: -1, mode: 'vertical', start: 0, ramp: 1, finishedAt: Infinity, fadeSeconds: 0.3, radius: 1, intensity: 1, seed: 0 });
    }
  }

  /**
   * Places a sigil. `ramp` seconds is the charge-up before launch (Infinity keeps charging until `finish`).
   * When every slot is busy the oldest one is recycled so a new cast always shows.
   */
  spawn(owner: number, mode: SigilMode, time: number, center: Vector3, normal: Vector3, radius: number, ramp: number, intensity: number, element: VfxElement = 'arcane'): SigilSlot {
    let slot = this.slots.find(candidate => !candidate.active);
    if (!slot) { slot = this.slots[0]!; for (const candidate of this.slots) if (candidate.start < slot.start) slot = candidate; }
    slot.active = true; slot.owner = owner; slot.mode = mode; slot.start = time; slot.ramp = ramp; slot.finishedAt = Infinity; slot.fadeSeconds = 0.3;
    slot.radius = Math.min(radius, SIGIL_RADIUS_MAX); slot.intensity = intensity; slot.seed = (owner * 0.6180339) % 1;
    const palette = PALETTE[element], u = slot.uniforms;
    u.uTex.value = element === 'heartroot' ? (this.heartrootTexture ??= createHeartrootRuneTexture())
      : element === 'umbral' ? (this.umbralTexture ??= createUmbralRuneTexture())
      : element === 'ember' ? (this.emberTexture ??= createEmberRuneTexture()) : this.texture;
    u.uColorA.value.copy(palette.a); u.uColorB.value.copy(palette.b); u.uColorHot.value.copy(palette.hot);
    u.uOuterOnly.value = mode === 'shatter' ? 1 : 0; u.uAlpha.value = 0;
    this.orient(slot, center, normal);
    slot.mesh.scale.setScalar(Math.max(1e-3, radius * 0.2));
    slot.mesh.visible = true;
    return slot;
  }

  /** Re-anchors a live sigil (it tracks the caster's facing while charging). */
  orient(slot: SigilSlot, center: Vector3, normal: Vector3): void {
    slot.center.copy(center);
    slot.normal.copy(normal).normalize();
    this.right.crossVectors(this.up, slot.normal);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.top.crossVectors(slot.normal, this.right);
    this.basis.makeBasis(this.right, this.top, slot.normal);
    slot.mesh.quaternion.setFromRotationMatrix(this.basis);
    slot.mesh.position.copy(slot.center);
  }

  /** Launch / end of charge: the sigil flares once and fades over `fadeSeconds`. */
  finish(slot: SigilSlot, time: number, fadeSeconds = 0.3): void {
    if (!slot.active || slot.finishedAt !== Infinity) return;
    slot.finishedAt = time; slot.fadeSeconds = Math.max(0.02, fadeSeconds);
  }

  release(slot: SigilSlot): void { slot.active = false; slot.owner = -1; slot.mesh.visible = false; }

  update(time: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const u = slot.uniforms, age = time - slot.start;
      if (age < 0) { slot.mesh.visible = false; continue; }
      let fade = 1, flare = 0;
      if (slot.finishedAt !== Infinity) {
        const since = time - slot.finishedAt;
        if (since >= slot.fadeSeconds) { this.release(slot); continue; }
        const fadeT = Math.min(1, since / slot.fadeSeconds);
        fade = 1 - fadeT * fadeT * (3 - 2 * fadeT);
        flare = Math.exp(-since * 12);
      }
      slot.mesh.visible = true;
      if (slot.mode === 'shatter') {
        const t = Math.min(1, age / Math.max(0.02, slot.fadeSeconds + 0.05));
        slot.mesh.scale.setScalar(Math.max(1e-3, slot.radius * (0.55 + 0.9 * (1 - (1 - t) * (1 - t)))));
        u.uAngles.value.set(age * 3.2 + slot.seed * 6, 0, 0);
        u.uIntensity.value = slot.intensity; u.uFlash.value = 0; u.uAlpha.value = fade * (1 - t) * (1 - t);
        continue;
      }
      const sustained = slot.ramp === Infinity, pre = sustained ? Math.min(1, age / 0.6) : Math.min(1, age / Math.max(1e-3, slot.ramp));
      const popT = Math.min(1, age / 0.18) - 1, appear = 1 + (OVERSHOOT + 1) * popT * popT * popT + OVERSHOOT * popT * popT;
      slot.mesh.scale.setScalar(Math.max(1e-3, slot.radius * (0.2 + 0.8 * appear) * (1 + (slot.mode === 'vertical' ? 0.06 * flare : 0))));
      const speed = 1 + 2.4 * pre * pre;
      const direction = slot.mode === 'ground' ? 0.6 : 1;
      u.uAngles.value.set(slot.seed * 6.28 + age * 0.9 * speed * direction, -age * 1.5 * speed * direction, age * 2.4 * speed * direction);
      const charge = 0.55 + 0.9 * pre + (sustained ? 0.55 * Math.min(1, Math.max(0, age - 0.6) / 1.4) + 0.06 * Math.sin(age * 18) : 0);
      u.uIntensity.value = Math.min(SIGIL_INTENSITY_MAX, slot.intensity * (charge + 0.9 * flare + (slot.finishedAt !== Infinity ? 0.25 * Math.sin(age * 44) : 0)));
      // The finish flare brightens the strokes via uIntensity; a centre flash at that intensity would bloom the
      // disc (which sits in front of Aren's chest) into an opaque white blob, so only a faint core remains.
      u.uFlash.value = Math.min(SIGIL_FLASH_MAX, Math.max(0, 1 - age / 0.16) + flare * 0.2);
      u.uAlpha.value = Math.min(1, age / 0.05) * fade;
    }
  }

  killOwner(owner: number): void { for (const slot of this.slots) if (slot.active && slot.owner === owner) this.release(slot); }
  clear(): void { for (const slot of this.slots) this.release(slot); }
  get activeCount(): number { let count = 0; for (const slot of this.slots) if (slot.active) count++; return count; }
  slotsView(): readonly SigilSlot[] { return this.slots; }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.geometry.dispose();
    for (const slot of this.slots) slot.mesh.material.dispose();
    this.texture.dispose();
    this.heartrootTexture?.dispose(); this.umbralTexture?.dispose(); this.emberTexture?.dispose();
  }
}

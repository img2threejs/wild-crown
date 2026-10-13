import { AdditiveBlending, Color, Group, Mesh, NormalBlending, PlaneGeometry, ShaderMaterial, Vector2, Vector4, type IUniform } from 'three';
import type { Footprint } from './footprint.js';
import { ELEMENT_INDEX, PALETTE, type VfxElement } from './palette.js';

/** fill: anticipation tell; burn: sustained active surface; shock: expanding band; decal: lingering stain. */
export type GroundKind = 'fill' | 'burn' | 'shock' | 'decal';
const MODE: Readonly<Record<GroundKind, number>> = { fill: 0, shock: 1, decal: 2, burn: 3 };
const SHAPE = { rect: 0, disk: 1, sector: 2 } as const;
type PoolName = 'surface' | 'shock' | 'decal';

const VERTEX = /* glsl */`
uniform vec4 uBounds;
varying vec2 vLocal;
void main() {
  vLocal = vec2(mix(uBounds.x, uBounds.y, position.x + 0.5), mix(uBounds.z, uBounds.w, position.z + 0.5));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/*
 * Every operation is finite for every input: pow() only receives non-negative bases (squares are
 * written as x * x), atan() never sees (0, 0), and divisions use clamped denominators.
 * Shapes are organic: rounded superellipse/ellipse/sector masks whose edge is eroded inward by noise
 * with a feather of 40 % of the half-extent, so no fill ever draws a crisp border.
 */
const FRAGMENT = /* glsl */`
uniform float uTime;
uniform int uMode;
uniform int uElement;
uniform int uShape;
uniform int uFillAxis;
uniform vec2 uHalf;
uniform float uRound;
uniform float uAperture;
uniform float uProgress;
uniform float uIntensity;
uniform float uAlpha;
uniform float uSeed;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorHot;
uniform vec3 uGlow;
varying vec2 vLocal;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
float safeAtan(float y, float x) { return atan(y, (abs(x) < 1e-5 && abs(y) < 1e-5) ? 1e-5 : x); }
float gauss(float x) { return exp(-min(x * x, 40.0)); }
float shapeDistance(vec2 p) {
  vec2 h = max(uHalf, vec2(0.05));
  if (uShape == 0) {
    vec2 a = abs(p) / h;
    return pow(pow(a.x, uRound) + pow(a.y, uRound), 1.0 / uRound);
  }
  if (uShape == 1) return length(p / h);
  float radial = length(p) / h.y;
  float angular = abs(safeAtan(p.x, p.y)) / max(0.5 * uAperture, 1e-3);
  return max(radial, angular);
}
float fillCoordinate(vec2 p, float d) {
  vec2 h = max(uHalf, vec2(0.05));
  if (uFillAxis == 1) return clamp((p.y + h.y) / (2.0 * h.y), 0.0, 1.0);
  if (uFillAxis == 2) return clamp(abs(p.x) / h.x, 0.0, 1.0);
  return clamp(d, 0.0, 1.0);
}
float bubbles(vec2 q, float t) {
  vec2 cell = floor(q * 2.4), local = fract(q * 2.4) - 0.5;
  float seed = hash(cell);
  float cycle = fract(seed * 7.0 + t * 0.35);
  float radius = 0.12 + 0.18 * cycle;
  return step(0.55, seed) * smoothstep(radius, radius - 0.06, length(local)) * (1.0 - cycle);
}
float ridges(vec2 q) { return 1.0 - abs(fbm(q) * 2.0 - 1.0); }
/** Animated element texture in 0..1 (metres-based so density is size independent). */
float pattern(vec2 q, vec2 p) {
  if (uElement == 0) return fbm(q * 1.3 + vec2(0.0, -uTime * 1.6));
  if (uElement == 1) {
    float n = fbm(q * 2.6);
    float veins = abs(sin(safeAtan(p.x, p.y) * 7.0 + n * 6.0));
    return clamp(n * 0.55 + 0.6 * veins * veins * veins * veins * veins * veins + 0.4 * smoothstep(0.86, 0.98, ridges(q * 2.2)), 0.0, 1.0);
  }
  if (uElement == 2) return clamp(fbm(q * 1.4 + vec2(uTime * 0.22, -uTime * 0.17)) * 0.7 + bubbles(q, uTime), 0.0, 1.0);
  if (uElement == 3) return smoothstep(0.45, 0.9, noise(vec2(q.x * 2.6, q.y * 0.5 - uTime * 3.2)));
  if (uElement == 4 || uElement == 5) return max(smoothstep(0.84, 0.97, ridges(q * 1.4)), fbm(q * 0.9) * 0.45);
  if (uElement == 7) {
    // Storm Warden: air-pressure rings sweeping outward over a faint rune lattice.
    float rings = gauss((fract(length(p) * 1.9 - uTime * 0.55) - 0.5) / 0.14);
    float lattice = smoothstep(0.9, 0.98, max(abs(sin(q.x * 3.1)), abs(sin(q.y * 3.1))));
    return clamp(0.25 * fbm(q * 1.2) + 0.75 * rings + 0.3 * lattice, 0.0, 1.0);
  }
  if (uElement == 8) return clamp(smoothstep(0.8, 0.97, ridges(q * 3.2 + uTime * 0.3)) + 0.3 * fbm(q * 1.5), 0.0, 1.0);
  if (uElement == 9) return max(smoothstep(0.82, 0.96, ridges(q * 1.7)), fbm(q * 1.1) * 0.5);
  if (uElement == 11) {
    // Heartroot: branching root veins converging on the centre, with sap pulses running along them.
    float web = smoothstep(0.78, 0.95, ridges(q * 1.9 + fbm(q * 0.8) * 1.4));
    float radial = pow(max(abs(sin(safeAtan(p.x, p.y) * 4.5 + fbm(q * 1.3) * 5.0)), 0.0), 8.0) * (1.0 - smoothstep(0.0, 1.0, length(p / max(uHalf, vec2(0.05))) * 0.9));
    float sap = 0.5 + 0.5 * sin(length(p) * 7.0 - uTime * 3.4);
    return clamp(max(web, radial) * (0.55 + 0.45 * sap) + 0.12 * fbm(q * 1.1), 0.0, 1.0);
  }
  if (uElement == 12) {
    // Umbral: razor crescent slits spiralling round the centre over slow ink-smoke, with a faint pulse running outward.
    float slit = smoothstep(0.93, 0.995, abs(sin(safeAtan(p.x, p.y) * 3.0 + length(p) * 2.4 - uTime * 0.6)));
    float xslit = smoothstep(0.9, 0.99, abs(sin(safeAtan(p.x, p.y) * 5.0 - length(p) * 3.1 + uTime * 0.4))) * 0.6;
    float pulse = 0.65 + 0.35 * sin(length(p) * 6.0 - uTime * 3.0);
    return clamp(max(slit, xslit) * pulse + 0.3 * fbm(q * 1.4 + vec2(uTime * 0.12, 0.0)), 0.0, 1.0);
  }
  if (uElement == 13) {
    // Ember: flame tongues licking up through glowing fracture lines.
    float tongues = pow(clamp(fbm(vec2(q.x * 2.2, q.y * 1.1 - uTime * 2.4)), 0.0, 1.0), 1.6) * 1.35;
    float cracks = smoothstep(0.84, 0.97, ridges(q * 1.8 + fbm(q * 0.9) * 0.8));
    return clamp(max(tongues * 0.8, cracks) + 0.1 * fbm(q * 1.2), 0.0, 1.0);
  }
  return fbm(q * 1.1 + vec2(uTime * 0.3, -uTime * 0.2));
}
void main() {
  vec2 p = vLocal;
  vec2 h = max(uHalf, vec2(0.05));
  vec2 q = p + vec2(uSeed * 17.0, uSeed * 31.0);
  float d = shapeDistance(p);
  // Noise only erodes inward; 40 % feather of the half-extent.
  float eroded = d + 0.3 * fbm(q * 1.7 + uSeed * 9.0);
  float mask = 1.0 - smoothstep(0.58, 1.0, eroded);
  if (mask <= 0.0 || d >= 1.0) discard;
  float n = pattern(q, p);
  vec3 color;
  float alpha;
  if (uMode == 0) {
    float g = fillCoordinate(p, d) + (fbm(q * 2.1 + uTime * 0.4) - 0.5) * 0.22;
    float reveal = 1.0 - smoothstep(uProgress - 0.22, uProgress + 0.02, g);
    float front = gauss((g - uProgress) / 0.07) * (1.0 - step(0.995, uProgress));
    float tex = n;
    if (uElement == 4 || uElement == 5) {
      // Travelling dust/fissure band along the wave's travel axis.
      float travel = fract(uTime * 0.7 + uSeed) * 2.0 - 1.0;
      tex = max(tex, 0.7 * gauss((p.y / h.y - travel) / 0.25));
    }
    vec3 base = mix(uColorA, uColorB, tex);
    if (uElement == 2) base = mix(uColorA * 0.6, uColorB * 0.45, bubbles(q, uTime));
    color = base * (reveal * (0.25 + 0.55 * tex) + front * 0.55) * uIntensity;
    alpha = mask * uAlpha * (0.2 + 0.6 * tex) * max(reveal, front) * 0.5;
  } else if (uMode == 1) {
    float x = (d - uProgress) / 0.075;
    float fade = 1.0 - uProgress;
    float band = gauss(x) * fade * sqrt(max(fade, 0.0));
    float grit = 0.55 + 0.7 * fbm(q * 3.0 - uTime);
    color = uColorB * band * grit * uIntensity;
    alpha = mask * band * uAlpha;
  } else if (uMode == 2) {
    float g = fillCoordinate(p, d);
    float revealed = 1.0 - smoothstep(uProgress - 0.12, uProgress, g);
    vec3 glow = uGlow / max(max(uGlow.r, uGlow.g), max(uGlow.b, 1e-3));
    if (uElement == 0) {
      float speck = smoothstep(0.8, 0.92, noise(q * 7.0));
      color = vec3(0.035, 0.026, 0.02) + glow * speck * 1.6 * uIntensity;
      alpha = smoothstep(0.22, 0.6, n * 0.8 + 0.25);
    } else if (uElement == 1) {
      color = mix(vec3(0.45, 0.62, 0.78), glow * 0.9, n * n);
      alpha = 0.18 + 0.4 * n;
    } else if (uElement == 2) {
      color = vec3(0.06, 0.14, 0.03) + glow * 0.35 * bubbles(q, uTime) * uIntensity;
      alpha = smoothstep(0.28, 0.62, n) * 0.7;
    } else if (uElement == 3) {
      color = vec3(0.3, 0.26, 0.2);
      alpha = n * 0.28;
    } else {
      float crack = smoothstep(0.86, 0.98, n);
      color = mix(vec3(0.05, 0.04, 0.03), glow * 1.8, crack * uIntensity);
      alpha = max(crack * 0.9, smoothstep(0.35, 0.75, n) * 0.3);
    }
    alpha *= mask * revealed * uAlpha;
  } else {
    float lane = uFillAxis == 1 ? abs(p.x) / h.x : d;
    float core = 1.0 - smoothstep(0.0, 0.22, lane);
    float flow = fbm(vec2(q.x * 2.0, q.y * 0.8 - uTime * 3.0));
    vec3 body = mix(uColorA, uColorB, flow) * (0.35 + 0.65 * flow);
    color = (body + uColorHot * core * flow * 0.35) * uIntensity;
    alpha = mask * (0.3 + 0.5 * max(flow, n)) * uAlpha;
  }
  color = clamp(color, vec3(0.0), vec3(4.0));
  alpha = clamp(alpha, 0.0, 1.0);
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(color, alpha);
}`;

type GroundUniforms = {
  uTime: IUniform<number>; uMode: IUniform<number>; uElement: IUniform<number>; uShape: IUniform<number>; uFillAxis: IUniform<number>;
  uHalf: IUniform<Vector2>; uRound: IUniform<number>; uAperture: IUniform<number>; uProgress: IUniform<number>; uIntensity: IUniform<number>; uAlpha: IUniform<number>;
  uSeed: IUniform<number>; uBounds: IUniform<Vector4>; uColorA: IUniform<Color>; uColorB: IUniform<Color>; uColorHot: IUniform<Color>; uGlow: IUniform<Color>;
};

export interface GroundSlot {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  readonly uniforms: GroundUniforms;
  kind: GroundKind;
  active: boolean;
  /** Auto slots animate and expire themselves; manual slots are driven by their cue kit. */
  auto: boolean;
  owner: number;
  start: number;
  life: number;
  fadeIn: number;
  fadeOut: number;
  peak: number;
}

/** Footprint-bounded quads: every pixel a cue draws lies inside its authored area. */
export class GroundFx {
  readonly group = new Group();
  private readonly geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly slots: GroundSlot[] = [];
  private readonly pools: Record<PoolName, GroundSlot[]> = { surface: [], shock: [], decal: [] };

  constructor() {
    this.group.name = 'vfx-ground';
    this.build('decal', 24, false, 1);
    this.build('surface', 18, true, 2);
    this.build('shock', 14, true, 3);
  }

  /**
   * Places a quad exactly over the footprint bounds. `life` ≤ 0 creates a manual slot that the
   * caller drives with `drive()` and returns with `release()`. `glow` tints decal embers/cracks
   * (owner identity); it defaults to the element itself.
   */
  spawn(kind: GroundKind, footprint: Footprint, element: VfxElement, owner: number, time: number, life: number, peak = 1, glow: VfxElement = element): GroundSlot | undefined {
    const pool = this.pools[kind === 'decal' ? 'decal' : kind === 'shock' ? 'shock' : 'surface'];
    let slot = pool.find(candidate => !candidate.active);
    if (!slot) for (const candidate of pool) if (candidate.auto && (!slot || candidate.start < slot.start)) slot = candidate;
    if (!slot) return undefined;
    slot.kind = kind; slot.active = true; slot.auto = life > 0; slot.owner = owner; slot.start = time; slot.life = life > 0 ? life : Infinity;
    slot.fadeIn = kind === 'decal' ? 0.12 : 0.04; slot.fadeOut = kind === 'decal' ? Math.min(1.8, life * 0.35) : 0.1; slot.peak = peak;
    const { mesh, uniforms: u } = slot, palette = PALETTE[element];
    footprint.toWorld((footprint.minX + footprint.maxX) / 2, (footprint.minZ + footprint.maxZ) / 2, mesh.position, kind === 'decal' ? 0.035 : kind === 'shock' ? 0.06 : 0.05);
    mesh.rotation.set(0, footprint.angle, 0);
    mesh.scale.set(footprint.maxX - footprint.minX, 1, footprint.maxZ - footprint.minZ);
    mesh.updateMatrix();
    u.uMode.value = MODE[kind]; u.uElement.value = ELEMENT_INDEX[element]; u.uShape.value = SHAPE[footprint.shape];
    u.uFillAxis.value = footprint.fillAxis; u.uAperture.value = footprint.aperture; u.uRound.value = footprint.round;
    u.uHalf.value.set(footprint.halfWidth, footprint.halfLength);
    u.uBounds.value.set(footprint.minX, footprint.maxX, footprint.minZ, footprint.maxZ);
    u.uColorA.value.copy(palette.a); u.uColorB.value.copy(palette.b); u.uColorHot.value.copy(palette.hot); u.uGlow.value.copy(PALETTE[glow].hot);
    u.uSeed.value = (owner * 0.6180339 + time * 0.37) % 1;
    u.uProgress.value = 0; u.uIntensity.value = peak; u.uAlpha.value = slot.auto ? 0 : 1; u.uTime.value = time;
    mesh.visible = true;
    return slot;
  }

  /** Manual drive for fill/burn slots owned by a live cue. */
  drive(slot: GroundSlot, progress: number, intensity: number, alpha: number): void {
    slot.uniforms.uProgress.value = progress; slot.uniforms.uIntensity.value = intensity; slot.uniforms.uAlpha.value = alpha;
  }

  release(slot: GroundSlot): void { slot.active = false; slot.owner = -1; slot.mesh.visible = false; }

  update(time: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const u = slot.uniforms;
      u.uTime.value = time;
      if (!slot.auto) continue;
      const age = time - slot.start;
      if (age >= slot.life) { this.release(slot); continue; }
      if (age < 0) { u.uAlpha.value = 0; continue; }
      if (slot.kind === 'shock') {
        const t = age / slot.life;
        u.uProgress.value = 1 - (1 - t) * (1 - t);
        u.uAlpha.value = 1;
        continue;
      }
      u.uAlpha.value = Math.min(1, age / slot.fadeIn) * Math.min(1, (slot.life - age) / Math.max(1e-3, slot.fadeOut));
      u.uProgress.value = slot.kind === 'decal' ? Math.min(1.12, age / 0.22 * 1.12) : 1;
      if (slot.kind === 'decal') u.uIntensity.value = slot.peak * Math.exp(-age * 1.1);
    }
  }

  killOwner(owner: number): void { for (const slot of this.slots) if (slot.active && slot.owner === owner) this.release(slot); }
  clear(): void { for (const slot of this.slots) this.release(slot); }

  activeCount(owner?: number): number {
    let count = 0;
    for (const slot of this.slots) if (slot.active && (owner === undefined || slot.owner === owner)) count++;
    return count;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    for (const slot of this.slots) slot.mesh.material.dispose();
  }

  private build(pool: PoolName, count: number, additive: boolean, order: number): void {
    for (let i = 0; i < count; i++) {
      const uniforms: GroundUniforms = {
        uTime: { value: 0 }, uMode: { value: 0 }, uElement: { value: 0 }, uShape: { value: 0 }, uFillAxis: { value: 0 },
        uHalf: { value: new Vector2(1, 1) }, uRound: { value: 4 }, uAperture: { value: 0 }, uProgress: { value: 0 }, uIntensity: { value: 1 }, uAlpha: { value: 0 },
        uSeed: { value: 0 }, uBounds: { value: new Vector4(-0.5, 0.5, -0.5, 0.5) },
        uColorA: { value: new Color() }, uColorB: { value: new Color() }, uColorHot: { value: new Color() }, uGlow: { value: new Color() },
      };
      const material = new ShaderMaterial({
        name: `vfx-ground-${pool}`, vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms, transparent: true, depthWrite: false,
        blending: additive ? AdditiveBlending : NormalBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 - order,
      });
      const mesh = new Mesh(this.geometry, material);
      mesh.name = `vfx-ground-${pool}`;
      mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = order; mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      const slot: GroundSlot = { mesh, uniforms, kind: pool === 'shock' ? 'shock' : pool === 'decal' ? 'decal' : 'fill', active: false, auto: false, owner: -1, start: 0, life: 1, fadeIn: 0.1, fadeOut: 0.1, peak: 1 };
      this.pools[pool].push(slot);
      this.slots.push(slot);
    }
  }
}

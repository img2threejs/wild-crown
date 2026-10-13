import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  PlaneGeometry,
  Group,
  Mesh,
  Points,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { FeatureContext, GroundFeature } from './BiomeProfile';
import { PLUNGE_POOL, WATERFALL_BASE } from './CanopyRiver';
import { hash3 } from './GroundNoise';

/** Particle budget (one Points draw call): drifting leaves and insects/motes around the player, spray and mist at the waterfall. */
export const LEAF_COUNT = 70;
export const MOTE_COUNT = 110;
export const SPRAY_COUNT = 110;
export const MIST_COUNT = 40;
const KIND_LEAF = 0;
const KIND_MOTE = 1;
const KIND_SPRAY = 2;
const KIND_MIST = 3;
/** The drifting volume follows the focus; leaves wrap inside this box (x, y, z in metres). */
const VOLUME = new Vector3(24, 5.5, 24);
const SEED = 6151;
/** Shafts: count of translucent slanted light columns and their reach. */
const SHAFT_HEIGHT = 24;
const SHAFT_SPACING = 15;

const PARTICLE_VERTEX = `
attribute vec4 aSeed;
attribute float aKind;
uniform float uTime;
uniform vec3 uFocus;
uniform vec3 uVolume;
uniform vec3 uFall;
uniform float uScale;
uniform float uReduced;
varying vec4 vColor;
varying float vLeaf;
varying float vAngle;
#include <fog_pars_vertex>

vec3 wrapAround(vec3 local) {
  vec3 p = local - uFocus;
  p = mod(p + 0.5 * uVolume, uVolume) - 0.5 * uVolume;
  return uFocus + p;
}

void main() {
  vec3 world;
  float size;
  vec3 tint;
  float alpha;
  float kept = 1.0;
  vLeaf = 0.0;
  vAngle = 0.0;
  if (aKind < 0.5) {
    // Falling leaf: slow fall, lateral flutter, tumbling.
    float fall = 0.45 + aSeed.w * 0.55;
    vec3 base = aSeed.xyz * uVolume;
    base.y = mod(base.y - uTime * fall, uVolume.y);
    base.x += sin(uTime * 0.9 + aSeed.z * 31.0) * 1.1 + uTime * 0.25;
    base.z += cos(uTime * 0.7 + aSeed.x * 27.0) * 1.1;
    world = wrapAround(vec3(base.x, 0.0, base.z));
    world.y = uFocus.y + 0.5 + base.y;
    size = 0.14 + aSeed.y * 0.085;
    tint = mix(vec3(0.42, 0.3, 0.1), vec3(0.3, 0.45, 0.14), step(0.45, fract(aSeed.x * 7.0)));
    tint = mix(tint, vec3(0.62, 0.3, 0.1), step(0.85, fract(aSeed.z * 5.0)));
    alpha = 0.9;
    kept = step(aSeed.w, mix(1.0, 0.35, uReduced));
    vLeaf = 1.0;
    vAngle = aSeed.x * 6.2832 + uTime * (0.6 + aSeed.y);
  } else if (aKind < 1.5) {
    // Insect / mote: tiny warm sparkles meandering near the ground.
    vec3 base = aSeed.xyz * uVolume;
    base.x += sin(uTime * (0.6 + aSeed.w) + aSeed.y * 40.0) * 1.4;
    base.z += cos(uTime * (0.5 + aSeed.w) + aSeed.x * 40.0) * 1.4;
    world = wrapAround(vec3(base.x, 0.0, base.z));
    world.y = uFocus.y + 0.6 + aSeed.y * 4.2 + sin(uTime * 1.3 + aSeed.z * 20.0) * 0.35;
    size = 0.055 + aSeed.w * 0.04;
    tint = vec3(1.0, 0.86, 0.5);
    alpha = (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (2.0 + aSeed.x * 3.0) + aSeed.z * 50.0))) * 0.85;
    kept = 1.0 - uReduced;
  } else if (aKind < 2.5) {
    // Spray off the fall's base: thrown out and up, then drops back (1.6 s life).
    float life = fract(uTime * 0.62 + aSeed.w);
    float t = life * 1.6;
    vec3 start = vec3(uFall.x + 0.4, uFall.y + 0.2, uFall.z + (aSeed.x * 2.0 - 1.0) * 3.2);
    vec3 velocity = vec3(0.7 + aSeed.y * 1.6, 1.2 + aSeed.z * 2.6, (aSeed.x - 0.5) * 1.1);
    world = vec3(start.x + velocity.x * t, start.y + velocity.y * t - 2.6 * t * t, start.z + velocity.z * t);
    size = 0.1 + aSeed.y * 0.1;
    tint = vec3(0.93, 0.97, 0.95);
    alpha = 0.7 * (1.0 - life) * smoothstep(0.0, 0.08, life);
    kept = step(aSeed.z, mix(1.0, 0.4, uReduced));
  } else {
    // Mist over the plunge pool: big soft puffs rising and spreading (7 s life).
    float life = fract(uTime * 0.14 + aSeed.w);
    vec3 start = vec3(uFall.x + 0.8 + aSeed.x * 7.5, uFall.y + 0.2, uFall.z + (aSeed.y * 2.0 - 1.0) * 5.0);
    world = vec3(start.x + life * 1.4, start.y + life * (1.6 + aSeed.z * 1.2), start.z + sin(life * 3.0 + aSeed.x * 20.0) * 0.8);
    size = 2.2 + life * 2.4 + aSeed.z * 1.2;
    tint = vec3(0.86, 0.93, 0.9);
    alpha = 0.16 * smoothstep(0.0, 0.2, life) * (1.0 - smoothstep(0.55, 1.0, life));
  }
  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  // Nothing may drift into the camera path: fade out inside 11 m of the camera and cull inside 8 m.
  float cameraDistance = length(world - cameraPosition);
  alpha *= smoothstep(8.0, 11.0, cameraDistance);
  kept *= step(8.0, cameraDistance);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = min(size * uScale / max(-mvPosition.z, 0.1), 40.0);
  vColor = vec4(tint, alpha);
  if (kept < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
  }
  #include <fog_vertex>
}`;

const PARTICLE_FRAGMENT = `
varying vec4 vColor;
varying float vLeaf;
varying float vAngle;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float alpha = vColor.a;
  vec3 color = vColor.rgb;
  if (vLeaf > 0.5) {
    // Leaf: a tumbling pointed ellipse.
    float angle = vAngle;
    vec2 r = vec2(p.x * cos(angle) - p.y * sin(angle), p.x * sin(angle) + p.y * cos(angle));
    float shape = 1.0 - smoothstep(0.2, 0.5, length(vec2(r.x * 0.9, r.y * 2.4)));
    alpha *= shape;
    color *= 0.75 + 0.5 * smoothstep(-0.08, 0.08, r.y);
  } else {
    alpha *= 1.0 - smoothstep(0.1, 0.5, length(p));
  }
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const SHAFT_VERTEX = `
attribute vec3 aShaft;
varying vec3 vShaft;
#include <fog_pars_vertex>
void main() {
  vShaft = aShaft;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

/** A soft warm column: gaussian across, faded at the ground and at the top, with slowly drifting dust in it. */
const SHAFT_FRAGMENT = `
uniform float uTime;
uniform vec3 uColor;
varying vec3 vShaft;
#include <fog_pars_fragment>
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float across = exp(-vShaft.x * vShaft.x * 3.2);
  float along = smoothstep(0.0, 0.18, vShaft.y) * (1.0 - smoothstep(0.5, 1.0, vShaft.y));
  float dust = 0.55 + 0.45 * vnoise(vec2(vShaft.x * 2.5 + vShaft.z * 9.0, vShaft.y * 3.0 - uTime * 0.12));
  float pulse = 0.75 + 0.25 * sin(uTime * 0.35 + vShaft.z * 40.0);
  float alpha = across * along * dust * pulse * 0.24;
  #ifdef USE_FOG
    alpha *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor = vec4(uColor * alpha, 1.0);
}`;

function approximateCameraRay(): Vector3 {
  // The gameplay camera looks along (−10, −12, −14) from the player.
  return new Vector3(-10, -12, -14).normalize();
}

export interface CanopyAtmosphereData {
  readonly particleSeeds: Float32Array;
  readonly particleKinds: Float32Array;
  readonly shafts: readonly { readonly x: number; readonly y: number; readonly z: number; readonly width: number }[];
}

function buildParticles(): { seeds: Float32Array; kinds: Float32Array } {
  const count = LEAF_COUNT + MOTE_COUNT + SPRAY_COUNT + MIST_COUNT;
  const seeds = new Float32Array(count * 4);
  const kinds = new Float32Array(count);
  let index = 0;
  const add = (kind: number, amount: number): void => {
    for (let item = 0; item < amount; item++, index++) {
      for (let channel = 0; channel < 4; channel++) seeds[index * 4 + channel] = hash3(item, channel, kind, SEED);
      kinds[index] = kind;
    }
  };
  add(KIND_LEAF, LEAF_COUNT);
  add(KIND_MOTE, MOTE_COUNT);
  add(KIND_SPRAY, SPRAY_COUNT);
  add(KIND_MIST, MIST_COUNT);
  return { seeds, kinds };
}

/** Light-shaft bases along the ribbons: every ~15 m of route, alternating sides 3–7 m off the centreline, on the ground. */
function shaftBases(context: FeatureContext): CanopyAtmosphereData['shafts'] {
  const bases: Array<{ x: number; y: number; z: number; width: number }> = [];
  let serial = 0;
  for (const ribbon of context.region.navigation.ribbons) {
    let travelled = 0;
    let next = SHAFT_SPACING * 0.5;
    for (let index = 1; index < ribbon.points.length; index++) {
      const a = ribbon.points[index - 1]!;
      const b = ribbon.points[index]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const dx = (b.x - a.x) / length;
      const dz = (b.z - a.z) / length;
      while (next < travelled + length) {
        const arc = next - travelled;
        const side = serial % 2 === 0 ? 1 : -1;
        const lateral = side * (3 + 4 * hash3(serial, 1, 0, SEED));
        const x = a.x + dx * arc - dz * lateral;
        const z = a.z + dz * arc + dx * lateral;
        bases.push({ x, y: context.field.sample(x, z), z, width: 2.6 + 2.2 * hash3(serial, 2, 0, SEED) });
        serial++;
        next += SHAFT_SPACING;
      }
      travelled += length;
    }
  }
  // The stage exit: a clearing in the canopy. Three wide shafts fall across the path so Aren and the trail stay readable.
  const exit = context.region.exits[0]?.from;
  if (exit) {
    for (const [dx, dz, width] of [[3.5, -1, 5.5], [5, 4, 5], [2, 6, 4.5]] as const) {
      const x = exit.x + dx;
      const z = exit.z + dz;
      bases.push({ x, y: context.field.sample(x, z), z, width });
    }
  }
  return bases;
}

function buildShaftGeometry(bases: CanopyAtmosphereData['shafts'], towardSun: Vector3): BufferGeometry {
  const view = approximateCameraRay();
  // Horizontal-ish width axis: perpendicular to both the ray towards the sun and the view direction, so the column faces the camera.
  const across = new Vector3().crossVectors(towardSun, view).normalize();
  const positions: number[] = [];
  const shaft: number[] = [];
  const indices: number[] = [];
  bases.forEach((base, serial) => {
    const first = positions.length / 3;
    for (const v of [0, 1]) {
      const half = (base.width * (0.5 + 0.3 * v)) / 1;
      const centreX = base.x + towardSun.x * SHAFT_HEIGHT * v;
      const centreY = base.y - 0.3 + towardSun.y * SHAFT_HEIGHT * v;
      const centreZ = base.z + towardSun.z * SHAFT_HEIGHT * v;
      for (const u of [-1, 1]) {
        positions.push(centreX + across.x * half * u, centreY + across.y * half * u, centreZ + across.z * half * u);
        shaft.push(u, v, serial / Math.max(1, bases.length));
      }
    }
    indices.push(first, first + 2, first + 1, first + 1, first + 2, first + 3);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('aShaft', new BufferAttribute(new Float32Array(shaft), 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Whispering Canopy atmosphere: drifting falling leaves and insects around the player, spray and mist at the waterfall (one
 * Points draw call, all motion in the vertex shader from the world clock) and warm light shafts through the canopy (one
 * additive mesh). Reduced effects drops the shafts and insects and thins leaves and spray.
 */
export class CanopyAtmosphere implements GroundFeature {
  readonly group = new Group();
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  readonly shafts: Mesh<BufferGeometry, ShaderMaterial> | undefined;
  readonly data: CanopyAtmosphereData;
  /** Warm ground glow at the stage exit (a readability aid: stays on under reduced effects). */
  readonly glow: Mesh | undefined;
  private readonly size = new Vector2();
  private disposed = false;

  constructor(context: FeatureContext) {
    this.group.name = 'canopy-atmosphere';
    const { seeds, kinds } = buildParticles();
    const bases = shaftBases(context);
    this.data = { particleSeeds: seeds, particleKinds: kinds, shafts: bases };
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(kinds.length * 3), 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    geometry.setAttribute('aKind', new BufferAttribute(kinds, 1));
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uFocus: { value: new Vector3(-58, 0, -20) },
          uVolume: { value: VOLUME.clone() },
          uFall: { value: new Vector3(WATERFALL_BASE.x, PLUNGE_POOL.waterY, WATERFALL_BASE.z) },
          uScale: { value: 600 },
          uReduced: { value: 0 },
        },
      ]),
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    material.name = 'canopy-particles';
    this.points = new Points(geometry, material);
    this.points.name = 'canopy-particles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.onBeforeRender = (renderer: WebGLRenderer, _scene: Scene, camera: Camera, _geometry: BufferGeometry, _material: unknown, _group: unknown) => this.syncScale(renderer, camera);
    this.group.add(this.points);

    if (bases.length > 0) {
      const shaftGeometry = buildShaftGeometry(bases, context.sunDirection);
      const shaftMaterial = new ShaderMaterial({
        uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime: { value: 0 }, uColor: { value: new Color(1.0, 0.8, 0.46) } }]),
        vertexShader: SHAFT_VERTEX,
        fragmentShader: SHAFT_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        fog: true,
      });
      shaftMaterial.name = 'canopy-light-shafts';
      this.shafts = new Mesh(shaftGeometry, shaftMaterial);
      this.shafts.name = 'canopy-light-shafts';
      this.shafts.frustumCulled = false;
      this.shafts.renderOrder = 3;
      this.group.add(this.shafts);
    }
    const exit = context.region.exits[0]?.from;
    if (exit) {
      // A warm clearing glow on the ground at the exit; it stays on in reduced-effects mode (it is a readability aid, not decoration).
      const glowGeometry = new PlaneGeometry(15, 15).rotateX(-Math.PI / 2);
      const glowMaterial = new ShaderMaterial({
        uniforms: { uColor: { value: new Color(1.0, 0.82, 0.5).multiplyScalar(0.28) } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 uColor; varying vec2 vUv;
void main() {
  float d = clamp(length(vUv - 0.5) * 2.0, 0.0, 1.0);
  gl_FragColor = vec4(uColor * pow(1.0 - d, 1.8), 1.0);
}`,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      this.glow = new Mesh(glowGeometry, glowMaterial);
      this.glow.name = 'canopy-exit-glow';
      this.glow.position.set(exit.x, context.field.sample(exit.x, exit.z) + 0.25, exit.z);
      this.glow.renderOrder = 3;
      this.glow.frustumCulled = false;
      this.group.add(this.glow);
    }
    this.setReducedEffects(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  update(worldTimeSeconds: number, focus: Readonly<{ x: number; y: number; z: number }> | undefined): void {
    if (this.disposed) return;
    this.points.material.uniforms.uTime!.value = worldTimeSeconds;
    if (this.shafts) this.shafts.material.uniforms.uTime!.value = worldTimeSeconds;
    if (focus) (this.points.material.uniforms.uFocus!.value as Vector3).set(focus.x, focus.y, focus.z);
  }

  setReducedEffects(reduced: boolean): void {
    this.points.material.uniforms.uReduced!.value = reduced ? 1 : 0;
    if (this.shafts) this.shafts.visible = !reduced;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
    if (this.shafts) {
      this.shafts.geometry.dispose();
      this.shafts.material.dispose();
    }
    if (this.glow) {
      this.glow.geometry.dispose();
      (this.glow.material as ShaderMaterial).dispose();
    }
  }

  /** Point size in pixels per metre at unit distance: the height of the active target times the projection's y scale / 2. */
  private syncScale(renderer: WebGLRenderer, camera: Camera): void {
    const target = renderer.getRenderTarget();
    const height = target ? target.height : renderer.getDrawingBufferSize(this.size).y;
    this.points.material.uniforms.uScale!.value = height * 0.5 * camera.projectionMatrix.elements[5]!;
  }
}

export function createCanopyAtmosphere(context: FeatureContext): GroundFeature {
  return new CanopyAtmosphere(context);
}

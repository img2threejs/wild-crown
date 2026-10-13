import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
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
import { hash3 } from './GroundNoise';
import { HEARTROOT_MOUND } from './GroveTerrain';

/** Particle budget (one Points draw call): drifting golden pollen, fireflies and loose petals around the player. */
export const POLLEN_COUNT = 140;
export const FIREFLY_COUNT = 36;
export const PETAL_COUNT = 30;
const KIND_POLLEN = 0;
const KIND_FIREFLY = 1;
const KIND_PETAL = 2;
/** The drifting volume follows the focus; particles wrap inside this box (x, y, z in metres). */
const VOLUME = new Vector3(26, 5, 26);
const SEED = 7219;
/** Reduced Motion / Reduced Effects keep this share of the pollen and drop fireflies and petals. */
const REDUCED_POLLEN_SHARE = 0.35;

const PARTICLE_VERTEX = `
attribute vec4 aSeed;
attribute float aKind;
uniform float uTime;
uniform vec3 uFocus;
uniform vec3 uVolume;
uniform float uScale;
uniform float uReduced;
varying vec4 vColor;
varying float vPetal;
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
  vPetal = 0.0;
  vAngle = 0.0;
  if (aKind < 0.5) {
    // Golden pollen: lazy upward drift with a slow lateral sway, glinting as it turns.
    vec3 base = aSeed.xyz * uVolume;
    base.x += sin(uTime * (0.25 + aSeed.w * 0.3) + aSeed.y * 40.0) * 1.6 + uTime * 0.12;
    base.z += cos(uTime * (0.2 + aSeed.w * 0.3) + aSeed.x * 40.0) * 1.6;
    world = wrapAround(vec3(base.x, 0.0, base.z));
    world.y = uFocus.y + 0.4 + mod(aSeed.y * uVolume.y + uTime * (0.08 + aSeed.w * 0.1), uVolume.y);
    size = 0.06 + aSeed.w * 0.05;
    tint = mix(vec3(1.0, 0.82, 0.38), vec3(1.0, 0.92, 0.6), aSeed.z);
    alpha = (0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * (1.2 + aSeed.x * 2.0) + aSeed.z * 50.0))) * 0.8;
    kept = step(aSeed.w, mix(1.0, ${REDUCED_POLLEN_SHARE.toFixed(2)}, uReduced));
  } else if (aKind < 1.5) {
    // Firefly: a wandering green-gold spark that blinks slowly near the ground.
    vec3 base = aSeed.xyz * uVolume;
    base.x += sin(uTime * (0.35 + aSeed.w * 0.4) + aSeed.y * 30.0) * 2.2;
    base.z += cos(uTime * (0.3 + aSeed.w * 0.4) + aSeed.x * 30.0) * 2.2;
    world = wrapAround(vec3(base.x, 0.0, base.z));
    world.y = uFocus.y + 0.5 + aSeed.y * 2.6 + sin(uTime * 0.9 + aSeed.z * 20.0) * 0.4;
    size = 0.1 + aSeed.w * 0.05;
    tint = vec3(0.78, 1.0, 0.42);
    float blink = smoothstep(0.35, 0.9, 0.5 + 0.5 * sin(uTime * (0.7 + aSeed.x * 0.8) + aSeed.z * 60.0));
    alpha = blink * 0.9;
    kept = 1.0 - uReduced;
  } else {
    // Petal: slow fall, flutter and tumbling; warm pink and cream.
    float fall = 0.28 + aSeed.w * 0.3;
    vec3 base = aSeed.xyz * uVolume;
    base.y = mod(base.y - uTime * fall, uVolume.y);
    base.x += sin(uTime * 0.7 + aSeed.z * 31.0) * 1.3 + uTime * 0.2;
    base.z += cos(uTime * 0.55 + aSeed.x * 27.0) * 1.3;
    world = wrapAround(vec3(base.x, 0.0, base.z));
    world.y = uFocus.y + 0.3 + base.y;
    size = 0.13 + aSeed.y * 0.07;
    tint = mix(vec3(1.0, 0.7, 0.76), vec3(1.0, 0.93, 0.8), step(0.5, fract(aSeed.x * 7.0)));
    alpha = 0.85;
    kept = 1.0 - uReduced;
    vPetal = 1.0;
    vAngle = aSeed.x * 6.2832 + uTime * (0.5 + aSeed.y);
  }
  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  // Nothing may drift into the camera path: fade out inside 11 m of the camera and cull inside 8 m.
  float cameraDistance = length(world - cameraPosition);
  alpha *= smoothstep(8.0, 11.0, cameraDistance);
  kept *= step(8.0, cameraDistance);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = min(size * uScale / max(-mvPosition.z, 0.1), 36.0);
  vColor = vec4(tint, alpha);
  if (kept < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
  }
  #include <fog_vertex>
}`;

const PARTICLE_FRAGMENT = `
varying vec4 vColor;
varying float vPetal;
varying float vAngle;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float alpha = vColor.a;
  vec3 color = vColor.rgb;
  if (vPetal > 0.5) {
    // Petal: a tumbling rounded ellipse.
    float angle = vAngle;
    vec2 r = vec2(p.x * cos(angle) - p.y * sin(angle), p.x * sin(angle) + p.y * cos(angle));
    alpha *= 1.0 - smoothstep(0.2, 0.5, length(vec2(r.x * 1.0, r.y * 1.9)));
  } else {
    alpha *= 1.0 - smoothstep(0.08, 0.5, length(p));
  }
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const GLOW_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const GLOW_FRAGMENT = `uniform vec3 uColor; uniform float uPulse; varying vec2 vUv;
void main() {
  float d = clamp(length(vUv - 0.5) * 2.0, 0.0, 1.0);
  gl_FragColor = vec4(uColor * pow(1.0 - d, 1.8) * uPulse, 1.0);
}`;

export interface GroveAtmosphereData {
  readonly particleSeeds: Float32Array;
  readonly particleKinds: Float32Array;
}

function buildParticles(): { seeds: Float32Array; kinds: Float32Array } {
  const count = POLLEN_COUNT + FIREFLY_COUNT + PETAL_COUNT;
  const seeds = new Float32Array(count * 4);
  const kinds = new Float32Array(count);
  let index = 0;
  const add = (kind: number, amount: number): void => {
    for (let item = 0; item < amount; item++, index++) {
      for (let channel = 0; channel < 4; channel++) seeds[index * 4 + channel] = hash3(item, channel, kind, SEED);
      kinds[index] = kind;
    }
  };
  add(KIND_POLLEN, POLLEN_COUNT);
  add(KIND_FIREFLY, FIREFLY_COUNT);
  add(KIND_PETAL, PETAL_COUNT);
  return { seeds, kinds };
}

function glowMesh(name: string, size: number, color: Color, x: number, y: number, z: number): Mesh<PlaneGeometry, ShaderMaterial> {
  const material = new ShaderMaterial({
    uniforms: { uColor: { value: color }, uPulse: { value: 1 } },
    vertexShader: GLOW_VERTEX, fragmentShader: GLOW_FRAGMENT, transparent: true, depthWrite: false, blending: AdditiveBlending,
  });
  const mesh = new Mesh(new PlaneGeometry(size, size).rotateX(-Math.PI / 2), material);
  mesh.name = name;
  mesh.position.set(x, y, z);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Grove atmosphere: drifting golden pollen, fireflies and loose petals around the player (one Points draw call, all motion in the
 * vertex shader from the world clock), a warm clearing glow on the ground at the stage exit and a soft gold-green glow at the
 * young Heartroot's foot. Reduced effects keeps a third of the pollen, drops fireflies, petals and the Heartroot glow, and keeps the exit glow
 * (a readability aid).
 */
export class GroveAtmosphere implements GroundFeature {
  readonly group = new Group();
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  readonly data: GroveAtmosphereData;
  /** Warm ground glow at the stage exit: stays on under reduced effects. */
  readonly exitGlow: Mesh<PlaneGeometry, ShaderMaterial> | undefined;
  readonly heartrootGlow: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly size = new Vector2();
  private disposed = false;

  constructor(context: FeatureContext) {
    this.group.name = 'grove-atmosphere';
    const { seeds, kinds } = buildParticles();
    this.data = { particleSeeds: seeds, particleKinds: kinds };
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(kinds.length * 3), 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    geometry.setAttribute('aKind', new BufferAttribute(kinds, 1));
    const start = context.region.navigation.nodes[0]?.position;
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uFocus: { value: new Vector3(start?.x ?? 0, start?.y ?? 0, start?.z ?? 0) },
          uVolume: { value: VOLUME.clone() },
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
    material.name = 'grove-particles';
    this.points = new Points(geometry, material);
    this.points.name = 'grove-particles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.onBeforeRender = (renderer: WebGLRenderer, _scene: Scene, camera: Camera) => this.syncScale(renderer, camera);
    this.group.add(this.points);

    const exit = context.region.exits[0]?.from;
    if (exit) {
      this.exitGlow = glowMesh('grove-exit-glow', 15, new Color(1.0, 0.82, 0.5).multiplyScalar(0.28), exit.x, context.field.sample(exit.x, exit.z) + 0.25, exit.z);
      this.group.add(this.exitGlow);
    }
    this.heartrootGlow = glowMesh('grove-heartroot-glow', 17, new Color(0.9, 0.95, 0.5).multiplyScalar(0.16), HEARTROOT_MOUND.x, context.field.sample(HEARTROOT_MOUND.x, HEARTROOT_MOUND.z) + 0.2, HEARTROOT_MOUND.z);
    this.group.add(this.heartrootGlow);
    this.setReducedEffects(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  update(worldTimeSeconds: number, focus: Readonly<{ x: number; y: number; z: number }> | undefined): void {
    if (this.disposed) return;
    this.points.material.uniforms.uTime!.value = worldTimeSeconds;
    this.heartrootGlow.material.uniforms.uPulse!.value = 0.85 + 0.15 * Math.sin(worldTimeSeconds * 0.6);
    if (focus) (this.points.material.uniforms.uFocus!.value as Vector3).set(focus.x, focus.y, focus.z);
  }

  setReducedEffects(reduced: boolean): void {
    this.points.material.uniforms.uReduced!.value = reduced ? 1 : 0;
    this.heartrootGlow.visible = !reduced;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
    for (const glow of [this.exitGlow, this.heartrootGlow]) {
      glow?.geometry.dispose();
      glow?.material.dispose();
    }
  }

  /** Point size in pixels per metre at unit distance: the height of the active target times the projection's y scale / 2. */
  private syncScale(renderer: WebGLRenderer, camera: Camera): void {
    const target = renderer.getRenderTarget();
    const height = target ? target.height : renderer.getDrawingBufferSize(this.size).y;
    this.points.material.uniforms.uScale!.value = height * 0.5 * camera.projectionMatrix.elements[5]!;
  }
}

export function createGroveAtmosphere(context: FeatureContext): GroundFeature {
  return new GroveAtmosphere(context);
}

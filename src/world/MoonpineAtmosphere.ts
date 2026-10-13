import {
  BufferAttribute,
  BufferGeometry,
  Group,
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
import { LAKE } from './MoonpineTerrain';

/**
 * Moonpine atmosphere (docs/features/moonpine-playtest.md): falling snow and blown spindrift around the player, twinkling ice
 * glints on the lake and cold mist drifting over it. One Points draw call, every particle's motion is computed in the vertex
 * shader from the world clock, so pause, slow motion and a restored world all agree. Reduced effects keeps a thin snowfall and
 * drops the spindrift, the glints and most of the mist.
 */
export const SNOW_COUNT = 180;
export const SPINDRIFT_COUNT = 36;
export const GLINT_COUNT = 70;
export const MIST_COUNT = 28;
const KIND_SNOW = 0;
const KIND_SPINDRIFT = 1;
const KIND_GLINT = 2;
const KIND_MIST = 3;
/** The falling snow follows the focus; flakes wrap inside this box (x, y, z in metres). */
const VOLUME = new Vector3(30, 9, 30);
const SEED = 3907;

const VERTEX = `
attribute vec4 aSeed;
attribute float aKind;
uniform float uTime;
uniform vec3 uFocus;
uniform vec3 uVolume;
uniform vec3 uLake;
uniform float uScale;
uniform float uReduced;
varying vec4 vColor;
varying float vStar;
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
  vStar = 0.0;
  if (aKind < 0.5) {
    // Snowflake: slow fall, lateral sway, a steady drift on the wind.
    float fall = 0.8 + aSeed.w * 0.7;
    vec3 base = aSeed.xyz * uVolume;
    base.y = mod(base.y - uTime * fall, uVolume.y);
    base.x += sin(uTime * 0.7 + aSeed.z * 31.0) * 0.9 + uTime * 0.55;
    base.z += cos(uTime * 0.6 + aSeed.x * 27.0) * 0.9 + uTime * 0.2;
    world = wrapAround(vec3(base.x, 0.0, base.z));
    world.y = uFocus.y + 0.2 + base.y;
    size = 0.075 + aSeed.y * 0.07;
    tint = mix(vec3(0.92, 0.96, 1.0), vec3(0.78, 0.88, 1.0), step(0.7, fract(aSeed.x * 7.0)));
    alpha = 0.85;
    kept = step(aSeed.w, mix(1.0, 0.35, uReduced));
  } else if (aKind < 1.5) {
    // Spindrift: low, fast, soft puffs of snow blown along the ground.
    vec3 base = aSeed.xyz * uVolume;
    base.x += uTime * (2.2 + aSeed.w * 1.6);
    base.z += sin(uTime * 0.5 + aSeed.y * 40.0) * 1.3 + uTime * 0.5;
    world = wrapAround(vec3(base.x, 0.0, base.z));
    world.y = uFocus.y + 0.25 + aSeed.y * 1.1;
    size = 0.55 + aSeed.w * 0.5;
    tint = vec3(0.86, 0.92, 1.0);
    alpha = 0.16 * (0.6 + 0.4 * sin(uTime * 1.3 + aSeed.z * 20.0));
    kept = 1.0 - uReduced;
  } else if (aKind < 2.5) {
    // Ice glint: a tiny cold sparkle on the lake that blinks on and off (world-fixed over the lake and its shelf).
    world = vec3(uLake.x + (aSeed.x * 2.0 - 1.0) * uLake.z * 1.15, 0.06, uLake.y + (aSeed.y * 2.0 - 0.7) * uLake.z * 0.75);
    world.y += 0.05 + aSeed.w * 0.4;
    float blink = pow(max(0.0, sin(uTime * (1.6 + aSeed.z * 2.4) + aSeed.w * 60.0)), 6.0);
    size = 0.28 + aSeed.z * 0.22;
    tint = vec3(0.8, 0.93, 1.0);
    alpha = blink * 0.95;
    vStar = 1.0;
    kept = 1.0 - uReduced;
  } else {
    // Lake mist: big soft cold puffs rising a little and spreading while they drift east (9 s life).
    float life = fract(uTime * 0.11 + aSeed.w);
    world = vec3(uLake.x + (aSeed.x * 2.0 - 1.0) * uLake.z * 1.1 + life * 3.0, 0.15 + life * (0.7 + aSeed.z * 0.6), uLake.y + (aSeed.y * 2.0 - 0.6) * uLake.z * 0.7);
    size = 2.4 + life * 2.2 + aSeed.z * 1.1;
    tint = vec3(0.82, 0.9, 0.98);
    alpha = 0.13 * smoothstep(0.0, 0.2, life) * (1.0 - smoothstep(0.55, 1.0, life));
    kept = step(aSeed.z, mix(1.0, 0.3, uReduced));
  }
  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  // Nothing may drift into the camera path: fade out inside 11 m of the camera and cull inside 8 m.
  float cameraDistance = length(world - cameraPosition);
  alpha *= smoothstep(8.0, 11.0, cameraDistance);
  kept *= step(8.0, cameraDistance);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = min(size * uScale / max(-mvPosition.z, 0.1), 48.0);
  vColor = vec4(tint, alpha);
  if (kept < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
  }
  #include <fog_vertex>
}`;

const FRAGMENT = `
varying vec4 vColor;
varying float vStar;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float alpha = vColor.a;
  if (vStar > 0.5) {
    // Four-point glint: two thin crossed bars with a soft core.
    float bars = max(max(1.0 - abs(p.x) * 7.0, 0.0) * max(1.0 - abs(p.y) * 2.2, 0.0), max(1.0 - abs(p.y) * 7.0, 0.0) * max(1.0 - abs(p.x) * 2.2, 0.0));
    alpha *= bars + 0.5 * (1.0 - smoothstep(0.0, 0.2, length(p)));
  } else {
    alpha *= 1.0 - smoothstep(0.1, 0.5, length(p));
  }
  gl_FragColor = vec4(vColor.rgb, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export interface MoonpineAtmosphereData {
  readonly particleSeeds: Float32Array;
  readonly particleKinds: Float32Array;
}

function buildParticles(): MoonpineAtmosphereData {
  const count = SNOW_COUNT + SPINDRIFT_COUNT + GLINT_COUNT + MIST_COUNT;
  const particleSeeds = new Float32Array(count * 4), particleKinds = new Float32Array(count);
  let index = 0;
  const add = (kind: number, amount: number): void => {
    for (let item = 0; item < amount; item++, index++) {
      for (let channel = 0; channel < 4; channel++) particleSeeds[index * 4 + channel] = hash3(item, channel, kind, SEED);
      particleKinds[index] = kind;
    }
  };
  add(KIND_SNOW, SNOW_COUNT);
  add(KIND_SPINDRIFT, SPINDRIFT_COUNT);
  add(KIND_GLINT, GLINT_COUNT);
  add(KIND_MIST, MIST_COUNT);
  return { particleSeeds, particleKinds };
}

export class MoonpineAtmosphere implements GroundFeature {
  readonly group = new Group();
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  readonly data: MoonpineAtmosphereData;
  private readonly size = new Vector2();
  private disposed = false;

  constructor(context: FeatureContext) {
    this.group.name = 'moonpine-atmosphere';
    this.data = buildParticles();
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.data.particleKinds.length * 3), 3));
    geometry.setAttribute('aSeed', new BufferAttribute(this.data.particleSeeds, 4));
    geometry.setAttribute('aKind', new BufferAttribute(this.data.particleKinds, 1));
    const spawn = context.region.navigation.nodes[0]?.position;
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uFocus: { value: new Vector3(spawn?.x ?? 0, spawn?.y ?? 0, spawn?.z ?? 0) },
          uVolume: { value: VOLUME.clone() },
          // Lake centre (x, z) and its half extent along x: the glints and mist sit over the lake and the shelf south of it.
          uLake: { value: new Vector3(LAKE.x, LAKE.z + 8, LAKE.radiusX) },
          uScale: { value: 600 },
          uReduced: { value: 0 },
        },
      ]),
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    material.name = 'moonpine-particles';
    this.points = new Points(geometry, material);
    this.points.name = 'moonpine-particles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.onBeforeRender = (renderer: WebGLRenderer, _scene: Scene, camera: Camera) => this.syncScale(renderer, camera);
    this.group.add(this.points);
    this.setReducedEffects(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  update(worldTimeSeconds: number, focus: Readonly<{ x: number; y: number; z: number }> | undefined): void {
    if (this.disposed) return;
    this.points.material.uniforms.uTime!.value = worldTimeSeconds;
    if (focus) (this.points.material.uniforms.uFocus!.value as Vector3).set(focus.x, focus.y, focus.z);
  }

  setReducedEffects(reduced: boolean): void {
    this.points.material.uniforms.uReduced!.value = reduced ? 1 : 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }

  /** Point size in pixels per metre at unit distance: the height of the active target times the projection's y scale / 2. */
  private syncScale(renderer: WebGLRenderer, camera: Camera): void {
    const target = renderer.getRenderTarget();
    const height = target ? target.height : renderer.getDrawingBufferSize(this.size).y;
    this.points.material.uniforms.uScale!.value = height * 0.5 * camera.projectionMatrix.elements[5]!;
  }
}

export function createMoonpineAtmosphere(context: FeatureContext): GroundFeature {
  return new MoonpineAtmosphere(context);
}

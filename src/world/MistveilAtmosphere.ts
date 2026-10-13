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
import { SOURCE_POOL } from './MistveilWater';

/** Particle budget (one Points draw call): luminous fireflies and drifting ground mist around the player, sap vapour at the source. */
export const FIREFLY_COUNT = 100;
export const MIST_COUNT = 112;
export const VAPOUR_COUNT = 28;
const KIND_FIREFLY = 0;
const KIND_MIST = 1;
const KIND_VAPOUR = 2;
/** The drifting volume follows the focus; mist and fireflies wrap inside this box (x, y, z in metres). */
const VOLUME = new Vector3(50, 4, 50);
const SEED = 4471;

const PARTICLE_VERTEX = `
attribute vec4 aSeed;
attribute float aKind;
uniform float uTime;
uniform vec3 uFocus;
uniform vec3 uVolume;
uniform vec3 uSource;
uniform float uScale;
uniform float uReduced;
varying vec4 vColor;
varying float vSoft;
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
  vSoft = 0.0;
  if (aKind < 0.5) {
    // Firefly: a tiny luminous teal-gold mote meandering low over the wetland, pulsing on and off.
    vec3 base = aSeed.xyz * uVolume;
    base.x += sin(uTime * (0.5 + aSeed.w * 0.6) + aSeed.y * 40.0) * 1.8;
    base.z += cos(uTime * (0.4 + aSeed.w * 0.6) + aSeed.x * 40.0) * 1.8;
    world = wrapAround(vec3(base.x, 0.0, base.z));
    world.y = uFocus.y + 0.35 + aSeed.y * 2.4 + sin(uTime * 1.1 + aSeed.z * 20.0) * 0.3;
    size = 0.075 + aSeed.w * 0.05;
    tint = mix(vec3(0.5, 1.0, 0.72), vec3(0.95, 0.95, 0.45), step(0.7, fract(aSeed.x * 11.0)));
    float pulse = 0.5 + 0.5 * sin(uTime * (1.3 + aSeed.x * 2.2) + aSeed.z * 50.0);
    alpha = (0.15 + 0.85 * pulse * pulse) * 0.95;
    kept = 1.0 - uReduced;
  } else if (aKind < 1.5) {
    // Ground mist: big soft banks drifting slowly down-river, hugging the ground.
    vec3 base = aSeed.xyz * uVolume;
    base.x -= uTime * (0.25 + aSeed.w * 0.3);
    base.z += sin(uTime * 0.07 + aSeed.x * 30.0) * 2.0;
    world = wrapAround(vec3(base.x, 0.0, base.z));
    world.y = uFocus.y + 0.25 + aSeed.y * 1.3;
    size = 3.4 + aSeed.z * 3.2;
    tint = vec3(0.74, 0.86, 0.84);
    alpha = 0.19 * (0.6 + 0.4 * sin(uTime * 0.2 + aSeed.x * 60.0));
    vSoft = 1.0;
    kept = step(aSeed.w, mix(1.0, 0.4, uReduced));
  } else {
    // Black Sap vapour over the source seep: dark violet puffs rising and spreading (8 s life).
    float life = fract(uTime * 0.125 + aSeed.w);
    vec3 start = vec3(uSource.x + (aSeed.x * 2.0 - 1.0) * 3.4, uSource.y + 0.2, uSource.z + (aSeed.y * 2.0 - 1.0) * 2.8);
    world = vec3(start.x - life * 1.6, start.y + life * (1.8 + aSeed.z * 1.4), start.z + sin(life * 3.0 + aSeed.x * 20.0) * 0.8);
    size = 1.6 + life * 2.2 + aSeed.z * 1.0;
    tint = vec3(0.2, 0.12, 0.28);
    alpha = 0.3 * smoothstep(0.0, 0.2, life) * (1.0 - smoothstep(0.5, 1.0, life));
    vSoft = 1.0;
    kept = step(aSeed.z, mix(1.0, 0.4, uReduced));
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

const PARTICLE_FRAGMENT = `
varying vec4 vColor;
varying float vSoft;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float falloff = mix(1.0 - smoothstep(0.08, 0.5, length(p)), 1.0 - smoothstep(0.0, 0.5, length(p)), vSoft);
  gl_FragColor = vec4(vColor.rgb, vColor.a * falloff);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export interface MistveilAtmosphereData {
  readonly particleSeeds: Float32Array;
  readonly particleKinds: Float32Array;
}

function buildParticles(): MistveilAtmosphereData {
  const count = FIREFLY_COUNT + MIST_COUNT + VAPOUR_COUNT;
  const particleSeeds = new Float32Array(count * 4);
  const particleKinds = new Float32Array(count);
  let index = 0;
  const add = (kind: number, amount: number): void => {
    for (let item = 0; item < amount; item++, index++) {
      for (let channel = 0; channel < 4; channel++) particleSeeds[index * 4 + channel] = hash3(item, channel, kind, SEED);
      particleKinds[index] = kind;
    }
  };
  add(KIND_FIREFLY, FIREFLY_COUNT);
  add(KIND_MIST, MIST_COUNT);
  add(KIND_VAPOUR, VAPOUR_COUNT);
  return { particleSeeds, particleKinds };
}

/**
 * Mistveil Basin atmosphere: luminous fireflies and slowly drifting low mist around the player, dark Black Sap vapour rising
 * from the polluted source (one Points draw call, all motion in the vertex shader from the world clock), and a cool teal glow
 * on the ground at the root cavern's goal ring. Reduced effects drops the fireflies and thins the mist and vapour; the exit
 * glow is a readability aid and stays on.
 */
export class MistveilAtmosphere implements GroundFeature {
  readonly group = new Group();
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  readonly data: MistveilAtmosphereData;
  readonly glow: Mesh | undefined;
  private readonly size = new Vector2();
  private disposed = false;

  constructor(context: FeatureContext) {
    this.group.name = 'mistveil-atmosphere';
    this.data = buildParticles();
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.data.particleKinds.length * 3), 3));
    geometry.setAttribute('aSeed', new BufferAttribute(this.data.particleSeeds, 4));
    geometry.setAttribute('aKind', new BufferAttribute(this.data.particleKinds, 1));
    const spawn = context.region.navigation.nodes[0]?.position ?? { x: 0, y: 0, z: 0 };
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uFocus: { value: new Vector3(spawn.x, spawn.y, spawn.z) },
          uVolume: { value: VOLUME.clone() },
          uSource: { value: new Vector3(SOURCE_POOL.x, SOURCE_POOL.waterY, SOURCE_POOL.z) },
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
    material.name = 'mistveil-particles';
    this.points = new Points(geometry, material);
    this.points.name = 'mistveil-particles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.onBeforeRender = (renderer: WebGLRenderer, _scene: Scene, camera: Camera) => this.syncScale(renderer, camera);
    this.group.add(this.points);

    const exit = context.region.exits[0]?.from;
    if (exit) {
      // A cool teal clearing glow on the ground at the exit; it stays on in reduced-effects mode (a readability aid, not decoration).
      const glowGeometry = new PlaneGeometry(15, 15).rotateX(-Math.PI / 2);
      const glowMaterial = new ShaderMaterial({
        uniforms: { uColor: { value: new Color(0.42, 0.95, 0.85).multiplyScalar(0.26) } },
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
      this.glow.name = 'mistveil-exit-glow';
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

export function createMistveilAtmosphere(context: FeatureContext): GroundFeature {
  return new MistveilAtmosphere(context);
}

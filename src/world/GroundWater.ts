import { BufferAttribute, BufferGeometry, Color, Mesh, ShaderMaterial, UniformsLib, UniformsUtils, Vector3 } from 'three';
import type { WaterPalette, WaterPlan, WaterPoolSpec, WaterStripSpec } from './BiomeProfile';
import { smoothstep } from './GroundNoise';
import type { TerrainField } from './GroundTerrain';

/** Rings and segments of an elliptical pool; the outer rings fade to nothing so the rim never shows a polygon edge. */
const POOL_RINGS = [0, 0.3, 0.55, 0.75, 0.88, 1];
const POOL_SEGMENTS = 32;
/** Water drawn before every transparent prop batch: those (bridges, trunks) use depthWrite = false, so draw order is what keeps planks over water. */
export const WATER_RENDER_ORDER = -1;

export interface WaterMeshData {
  readonly positions: Float32Array;
  /** Per vertex: signed water depth over the terrain mesh (m, negative on land), and end/lateral/rim fade (0–1). */
  readonly flow: Float32Array;
  /** Per vertex: unit flow direction (x, z) and turbulence (0 calm … 1 rapids). */
  readonly aux: Float32Array;
  readonly indices: Uint32Array;
}

class WaterBuilder {
  readonly positions: number[] = [];
  readonly flow: number[] = [];
  readonly aux: number[] = [];
  readonly indices: number[] = [];

  vertex(field: TerrainField, x: number, waterY: number, z: number, fade: number, dirX: number, dirZ: number, turbulence: number): number {
    const index = this.positions.length / 3;
    this.positions.push(x, waterY, z);
    this.flow.push(waterY - field.sample(x, z), fade);
    this.aux.push(dirX, dirZ, turbulence);
    return index;
  }

  strip(field: TerrainField, spec: WaterStripSpec): void {
    const { rows, columns } = spec;
    const first = this.positions.length / 3;
    for (const row of rows) {
      // Across the flow: (dirZ, −dirX) is the flow direction rotated a quarter turn, so a +z flow spans +x.
      const acrossX = row.dirZ;
      const acrossZ = -row.dirX;
      for (let column = 0; column < columns; column++) {
        const u = (column / (columns - 1)) * 2 - 1;
        this.vertex(field, row.x + acrossX * u * row.halfWidth, row.waterY, row.z + acrossZ * u * row.halfWidth, row.fade * (1 - smoothstep(0.8, 1, Math.abs(u))), row.dirX, row.dirZ, row.turbulence);
      }
    }
    for (let row = 0; row < rows.length - 1; row++) {
      for (let column = 0; column < columns - 1; column++) {
        const a = first + row * columns + column;
        const b = a + 1;
        const c = a + columns;
        const d = c + 1;
        // Counter-clockwise seen from above (+y): water is only ever visible from above.
        this.indices.push(a, c, b, b, c, d);
      }
    }
  }

  pool(field: TerrainField, spec: WaterPoolSpec): void {
    const first = this.positions.length / 3;
    const cos = Math.cos(spec.rotation);
    const sin = Math.sin(spec.rotation);
    for (const ring of POOL_RINGS) {
      for (let segment = 0; segment < POOL_SEGMENTS; segment++) {
        const angle = (segment / POOL_SEGMENTS) * Math.PI * 2;
        const lx = Math.cos(angle) * spec.radiusX * ring;
        const lz = Math.sin(angle) * spec.radiusZ * ring;
        const px = spec.x + lx * cos - lz * sin;
        const pz = spec.z + lx * sin + lz * cos;
        const churn = spec.impact ? (1 - smoothstep(0, spec.impact.radius, Math.hypot(px - spec.impact.x, pz - spec.impact.z))) * (1 - spec.turbulence) : 0;
        // aux (0, 0): no flow direction marks a pool for the shader.
        this.vertex(field, px, spec.waterY, pz, 1 - smoothstep(0.82, 1, ring), 0, 0, spec.turbulence + churn);
      }
    }
    for (let ring = 0; ring < POOL_RINGS.length - 1; ring++) {
      for (let segment = 0; segment < POOL_SEGMENTS; segment++) {
        const next = (segment + 1) % POOL_SEGMENTS;
        const a = first + ring * POOL_SEGMENTS + segment;
        const b = first + ring * POOL_SEGMENTS + next;
        const c = first + (ring + 1) * POOL_SEGMENTS + segment;
        const d = first + (ring + 1) * POOL_SEGMENTS + next;
        this.indices.push(a, b, c, b, d, c);
      }
    }
  }
}

/** Every strip and pool of the plan as one geometry; depth is measured against the rendered terrain mesh. */
export function buildWaterData(field: TerrainField, plan: WaterPlan): WaterMeshData {
  const builder = new WaterBuilder();
  for (const spec of plan.strips) builder.strip(field, spec);
  for (const pool of plan.pools) builder.pool(field, pool);
  return {
    positions: Float32Array.from(builder.positions),
    flow: Float32Array.from(builder.flow),
    aux: Float32Array.from(builder.aux),
    indices: Uint32Array.from(builder.indices),
  };
}

const VERTEX_SHADER = `
attribute vec2 aFlow;
attribute vec3 aAux;
uniform float uRiverLevelOffset;
varying vec2 vFlow;
varying vec3 vAux;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  float levelOffset = dot(aAux.xy, aAux.xy) > 0.0 ? uRiverLevelOffset : 0.0;
  vFlow = aFlow + vec2(levelOffset, 0.0);
  vAux = aAux;
  vec4 world = modelMatrix * vec4(position + vec3(0.0, levelOffset, 0.0), 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

/**
 * One cheap pass for a shallow forest stream: two scrolling small-scale value-noise octaves (moving along each vertex's flow
 * direction, faster in rapids) give the ripple normal; depth tints olive-brown shallows into dark teal, alpha falls to nothing
 * over the last ~0.14 m of depth so no polygon edge shows at a bank, and an irregular thin foam line forms where the water
 * meets the bank (plus foam streaks in rapids). Sky reflection is weak and tinted, never milky.
 */
function fragmentShader(deepDepth: number): string {
  return `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSky;
uniform vec3 uSun;
uniform vec3 uFoam;
varying vec2 vFlow;
varying vec3 vAux;
varying vec3 vWorld;
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

float ripple(vec2 p, float speed) {
  vec2 flowA = p * vec2(5.2, 2.6) - vec2(0.0, uTime * 1.25 * speed);
  vec2 flowB = p * vec2(10.4, 4.9) + vec2(3.7, -uTime * 1.9 * speed);
  return vnoise(flowA) * 0.6 + vnoise(flowB) * 0.4;
}

void main() {
  float depth = max(vFlow.x, 0.0);
  float turb = clamp(vAux.z, 0.0, 1.0);
  vec2 dir = normalize(vAux.xy + vec2(1e-5, 0.0));
  vec2 p = vec2(dot(vWorld.xz, vec2(dir.y, -dir.x)), dot(vWorld.xz, dir));
  float speed = 1.0 + turb * 1.7;
  float e = 0.05;
  float h = ripple(p, speed);
  float tilt = 0.08 + 0.1 * turb;
  vec3 normal = normalize(vec3((h - ripple(p + vec2(e, 0.0), speed)) / e * tilt, 1.0, (h - ripple(p + vec2(0.0, e), speed)) / e * tilt));
  vec3 view = normalize(cameraPosition - vWorld);
  float fresnel = clamp(pow(1.0 - max(dot(normal, view), 0.0), 3.2) * 1.2, 0.0, 1.0);
  float deep = smoothstep(0.0, ${deepDepth.toFixed(3)}, depth);
  // Pools carry no flow direction: murky green-brown standing water with floating lily pads and leaf litter.
  float pool = step(length(vAux.xy), 0.5);
  vec3 color = mix(uShallow, uDeep, deep) * mix(1.0, 0.7, deep);
  color = mix(color, vec3(0.05, 0.07, 0.03), pool * 0.5);
  // Irregular bank foam: a thin broken line right at the waterline, plus whitewater streaks that grow with turbulence.
  float shoreline = (1.0 - smoothstep(0.0, 0.06, depth)) * (1.0 - 0.8 * pool);
  float broken = smoothstep(0.38, 0.8, vnoise(p * vec2(9.0, 4.5) - vec2(0.0, uTime * 0.9 * speed)) * 0.65 + vnoise(p * vec2(23.0, 11.0) + vec2(1.7, -uTime * 0.6 * speed)) * 0.35);
  float streak = smoothstep(0.74 - 0.2 * turb, 0.95 - 0.1 * turb, h) * (0.05 + 0.6 * turb) * (0.4 + 0.6 * broken);
  float foam = clamp(shoreline * (0.2 + 0.8 * broken) + streak, 0.0, 1.0);
  vec3 halfway = normalize(uSunDir + view);
  float glint = pow(max(dot(normal, halfway), 0.0), 260.0);
  color = mix(color, uSky, fresnel * 0.14);
  color = mix(color, uFoam * 0.8, foam * 0.7) + uSun * glint * 0.06;
  float shore = smoothstep(0.0, 0.14, depth);
  float body = mix(0.62, 0.92, deep) * shore;
  if (pool > 0.5) {
    // Lily pads (round, notched, ~0.4 m) and drifting leaf litter on a 1.1 m jittered grid, with a calm slow drift.
    vec2 g = vWorld.xz * 0.9 + vec2(uTime * 0.012, 0.0);
    vec2 cell = floor(g);
    vec2 local = fract(g) - 0.5 - (vec2(hash21(cell + 3.1), hash21(cell + 7.7)) - 0.5) * 0.45;
    float chance = hash21(cell);
    float radius = 0.2 + 0.08 * hash21(cell + 1.3);
    float d = length(local);
    float notch = 1.0 - step(0.84, dot(normalize(local + 1e-4), vec2(cos(chance * 6.28), sin(chance * 6.28)))) * step(0.04, d);
    float lily = step(0.5, chance) * (1.0 - smoothstep(radius - 0.025, radius, d)) * notch;
    float leaf = step(chance, 0.22) * (1.0 - smoothstep(0.08, 0.1, length(vec2(local.x * 0.55, local.y))));
    vec3 padColor = mix(vec3(0.05, 0.16, 0.04), vec3(0.14, 0.26, 0.07), hash21(cell + 9.1));
    vec3 leafColor = vec3(0.2, 0.11, 0.04);
    float padAlpha = clamp(lily + leaf, 0.0, 1.0) * smoothstep(0.1, 0.3, depth);
    color = mix(color, mix(padColor, leafColor, step(chance, 0.22)), padAlpha);
    body = mix(body, 0.97, padAlpha);
  }
  float alpha = max(body, foam * 0.6 * smoothstep(0.0, 0.02, depth)) * vFlow.y;
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
}

/**
 * Water of one biome: every river strip and pool in a single transparent geometry, drawn in one call with a lightweight custom
 * shader (no shadow casting or receiving). It fades out where a channel's bed climbs out of the ground and at pool rims; the
 * terrain mesh itself hides the surface wherever a bank rises above the water. Rendered before the transparent prop batches
 * ({@link WATER_RENDER_ORDER}) so bridges and trunks always draw over it.
 */
export class GroundWater {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly data: WaterMeshData;
  private readonly sunDirection = new Vector3(-0.78, 0.55, 0.29).normalize();
  private disposed = false;

  constructor(field: TerrainField, plan: WaterPlan) {
    this.data = buildWaterData(field, plan);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.data.positions, 3));
    geometry.setAttribute('aFlow', new BufferAttribute(this.data.flow, 2));
    geometry.setAttribute('aAux', new BufferAttribute(this.data.aux, 3));
    geometry.setIndex(new BufferAttribute(this.data.indices, 1));
    geometry.computeBoundingSphere();
    const palette: WaterPalette = plan.palette;
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uRiverLevelOffset: { value: 0 },
          uSunDir: { value: this.sunDirection },
          uShallow: { value: new Color(palette.shallow) },
          uDeep: { value: new Color(palette.deep) },
          uSky: { value: new Color(palette.sky) },
          uSun: { value: new Color(palette.sun) },
          uFoam: { value: new Color(palette.foam) },
        },
      ]),
      vertexShader: VERTEX_SHADER,
      fragmentShader: fragmentShader(plan.deepDepth),
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    material.name = plan.name;
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = plan.name;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = WATER_RENDER_ORDER;
  }

  /** Recolors existing water; river displacement leaves independent still pools in place. */
  setWaterway(palette: WaterPalette, riverLevelOffset: number): void {
    const uniforms = this.mesh.material.uniforms;
    uniforms.uShallow!.value.setHex(palette.shallow);
    uniforms.uDeep!.value.setHex(palette.deep);
    uniforms.uSky!.value.setHex(palette.sky);
    uniforms.uSun!.value.setHex(palette.sun);
    uniforms.uFoam!.value.setHex(palette.foam);
    uniforms.uRiverLevelOffset!.value = riverLevelOffset;
  }

  /** Points the glint along the key light (direction from the water towards the sun). */
  setSunDirection(toSun: Readonly<Vector3>): void {
    this.sunDirection.copy(toSun).normalize();
  }

  /** Advances the flow animation from the shared world clock. */
  update(worldTimeSeconds: number): void {
    if (!this.disposed) this.mesh.material.uniforms.uTime!.value = worldTimeSeconds;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import type { FeatureContext, GroundFeature } from './BiomeProfile';
import { HEADWATER_SAMPLES, PLUNGE_POOL, RIVER_WATER_DEPTH, WATERFALL_BASE } from './CanopyRiver';
import { WATER_RENDER_ORDER } from './GroundWater';
import type { TerrainField } from './GroundTerrain';

const ROWS = 30;
const COLUMNS = 13;
/** The sheet floats this far in front of the rock so it never z-fights the cliff. */
const FACE_OFFSET = 0.16;
const TOP_HALF_WIDTH = 2.3;
const BOTTOM_HALF_WIDTH = 3.9;
/** The fall begins at the headwater stream's last sample and ends at the plunge pool's surface. */
const SEARCH_START_X = -66;
const SEARCH_STEP = 0.1;

export interface WaterfallGeometryData {
  readonly positions: Float32Array;
  /** Per vertex: u across the sheet (−1…1), v down the fall (0 at the lip, 1 at the pool), height above the pool (m). */
  readonly coordinates: Float32Array;
  readonly indices: Uint32Array;
  readonly lipY: number;
  readonly baseY: number;
}

/** X of the rock face at (z, y): marches from the pool side towards the cliff until the terrain reaches `y`. */
function faceX(field: TerrainField, z: number, y: number): number {
  let x = SEARCH_START_X;
  for (let step = 0; step < 400; step++) {
    if (field.sample(x, z) >= y) return x;
    x -= SEARCH_STEP;
  }
  return x;
}

/**
 * The waterfall's sheet: a grid that hugs the actual rendered cliff (terrain heights), from the headwater stream's lip down to
 * the plunge pool's surface, so it can never float in front of nor sink into the rock.
 */
export function buildWaterfallGeometry(field: TerrainField): WaterfallGeometryData {
  const lipSample = HEADWATER_SAMPLES[HEADWATER_SAMPLES.length - 1]!;
  const lipY = lipSample.bed + RIVER_WATER_DEPTH;
  const baseY = PLUNGE_POOL.waterY;
  const positions = new Float32Array(ROWS * COLUMNS * 3);
  const coordinates = new Float32Array(ROWS * COLUMNS * 3);
  const faces = new Float32Array(ROWS * COLUMNS);
  for (let row = 0; row < ROWS; row++) {
    const v = row / (ROWS - 1);
    const y = lipY + (baseY - lipY) * v;
    const halfWidth = TOP_HALF_WIDTH + (BOTTOM_HALF_WIDTH - TOP_HALF_WIDTH) * v;
    for (let column = 0; column < COLUMNS; column++) {
      const u = (column / (COLUMNS - 1)) * 2 - 1;
      const z = WATERFALL_BASE.z + u * halfWidth;
      const index = row * COLUMNS + column;
      faces[index] = faceX(field, z, y);
      positions[index * 3 + 2] = z;
      positions[index * 3 + 1] = y;
      coordinates[index * 3] = u;
      coordinates[index * 3 + 1] = v;
      coordinates[index * 3 + 2] = y - baseY;
    }
  }
  const raw = faces.slice();
  // Light smoothing down each column so crags do not tear the sheet, then the offset in front of the rock.
  for (let pass = 0; pass < 2; pass++) {
    for (let column = 0; column < COLUMNS; column++) {
      for (let row = 1; row < ROWS - 1; row++) {
        const index = row * COLUMNS + column;
        faces[index] = (faces[index - COLUMNS]! + 2 * faces[index]! + faces[index + COLUMNS]!) / 4;
      }
    }
  }
  // Smoothing may only move the sheet away from the rock (towards the pool), never into it.
  for (let index = 0; index < ROWS * COLUMNS; index++) positions[index * 3] = Math.max(faces[index]!, raw[index]!) + FACE_OFFSET;
  const indices: number[] = [];
  for (let row = 0; row < ROWS - 1; row++) {
    for (let column = 0; column < COLUMNS - 1; column++) {
      const a = row * COLUMNS + column;
      const b = a + 1;
      const c = a + COLUMNS;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { positions, coordinates, indices: Uint32Array.from(indices), lipY, baseY };
}

const VERTEX_SHADER = `
attribute vec3 aSheet;
varying vec3 vSheet;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vSheet = aSheet;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

/**
 * Falling water: two scrolling streak layers along the fall (u across, v down), a bright core, ragged edges, whitewater
 * thickening towards the pool and a soft foam band at the base. Alpha-blended, no depth write, drawn before transparent props.
 */
const FRAGMENT_SHADER = `
uniform float uTime;
uniform vec3 uBody;
uniform vec3 uFoam;
uniform vec3 uSky;
varying vec3 vSheet;
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

void main() {
  float u = vSheet.x;
  float v = vSheet.y;
  float fall = vSheet.z;
  // Streaks: tall thin noise scrolling down at two speeds.
  float streakA = vnoise(vec2(u * 7.0, fall * 0.55 + uTime * 3.4));
  float streakB = vnoise(vec2(u * 15.0 + 4.1, fall * 0.9 + uTime * 5.2));
  float streaks = streakA * 0.6 + streakB * 0.4;
  // Ragged lateral edge.
  float edgeNoise = vnoise(vec2(fall * 0.7 + uTime * 1.3, u * 3.0));
  float edge = 1.0 - smoothstep(0.62 + 0.18 * edgeNoise, 1.0, abs(u));
  // Thicker, whiter water towards the pool; foam band right at the base.
  float churn = smoothstep(0.45, 1.0, v);
  float baseFoam = smoothstep(0.86, 1.0, v) * (0.55 + 0.45 * vnoise(vec2(u * 9.0 + uTime * 0.7, uTime * 1.9)));
  vec3 color = mix(uBody, uFoam, clamp(streaks * 0.55 + churn * 0.4 + baseFoam, 0.0, 1.0));
  color = mix(color, uSky, 0.12);
  float alpha = (0.34 + 0.45 * smoothstep(0.3, 0.8, streaks) + 0.2 * churn + 0.3 * baseFoam) * edge;
  // The lip fades in so the sheet grows out of the stream.
  alpha *= smoothstep(0.0, 0.07, v);
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.92));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class CanopyWaterfall implements GroundFeature {
  readonly group = new Group();
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly data: WaterfallGeometryData;
  private disposed = false;

  constructor(field: TerrainField) {
    this.group.name = 'canopy-waterfall';
    this.data = buildWaterfallGeometry(field);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.data.positions, 3));
    geometry.setAttribute('aSheet', new BufferAttribute(this.data.coordinates, 3));
    geometry.setIndex(new BufferAttribute(this.data.indices, 1));
    geometry.computeBoundingSphere();
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uBody: { value: new Color(0x9fc6c0) },
          uFoam: { value: new Color(0xeef6f1) },
          uSky: { value: new Color(0x9db7a8) },
        },
      ]),
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
    });
    material.name = 'canopy-waterfall';
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'canopy-waterfall';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = true;
    this.mesh.renderOrder = WATER_RENDER_ORDER;
    this.group.add(this.mesh);
  }

  update(worldTimeSeconds: number): void {
    if (!this.disposed) this.mesh.material.uniforms.uTime!.value = worldTimeSeconds;
  }

  setReducedEffects(): void {
    // The sheet is a single animated mesh with no particles: nothing to thin.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export function createCanopyWaterfall(context: FeatureContext): GroundFeature {
  return new CanopyWaterfall(context.field);
}

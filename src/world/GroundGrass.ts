import {
  BufferAttribute,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  BufferGeometry,
  Mesh,
  MeshLambertMaterial,
  Sphere,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { UnderstoryProfile } from './BiomeProfile';
import { hash3, smoothstep, valueNoise } from './GroundNoise';
import { grassDensity } from './GroundScatter';
import { withCheapShadows } from './GroundShadow';
import { createMaskSample, sampleMask, type GroundMask } from './GroundMask';
import type { TerrainField } from './GroundTerrain';

/** Streaming pool: at most GRASS_POOL tiles (= draw calls) of GRASS_TILE m, ≤ 150 000 blades alive in total. */
export const GRASS_TILE = 10;
export const GRASS_POOL = 12;
const GRID = 45;
export const BLADES_PER_CLUMP = 6;
export const GRASS_MAX_CLUMPS_PER_TILE = GRID * GRID;
export const GRASS_MAX_BLADES = GRASS_POOL * GRASS_MAX_CLUMPS_PER_TILE * BLADES_PER_CLUMP;
const FILLS_PER_FRAME = 4;
const WINDOW = 3;
/**
 * The locked gameplay camera looks along (−10, −14) over the ground, so the visible
 * ground centres ahead of the player; tiles are streamed around that point.
 */
const VIEW_BIAS_X = -2.9;
const VIEW_BIAS_Z = -4.1;
/** Blades shrink to nothing between FADE_START and FADE_END metres from the streaming centre. */
const FADE_START = 9.5;
const FADE_END = 13.5;
/** Distance-scaled density: every clump has a rank in [0, 1); only ranks below keep(d) are alive at distance d. */
const KEEP_NEAR = 4.5;
const KEEP_FAR = 12;
const KEEP_FLOOR = 0.2;
/** Rank resolution of the per-tile prefix cull (instances are stored sorted by rank). */
const RANK_BUCKETS = 16;
/** Ranks cross-fade over this fraction of the range so thinning shrinks blades instead of popping them. */
const RANK_SOFTNESS = 1 / 8;
const SEED = 5309;

/** Fraction of clumps alive at `distance` metres from the streaming centre (1 near the player, KEEP_FLOOR at KEEP_FAR, 0 once faded out). */
export function grassKeepFraction(distance: number): number {
  return distance >= FADE_END ? 0 : 1 - (1 - KEEP_FLOOR) * smoothstep(KEEP_NEAR, KEEP_FAR, distance);
}

interface Tile {
  readonly mesh: Mesh<InstancedBufferGeometry, MeshLambertMaterial>;
  readonly position: InstancedBufferAttribute;
  readonly params: InstancedBufferAttribute;
  /** Blight 0..1 per clump (wilted, dark blades), 0 for biomes without a blight. */
  readonly blight: InstancedBufferAttribute;
  /** Cumulative instance counts per rank bucket; bucketEnd[RANK_BUCKETS - 1] is the tile's clump count. */
  readonly bucketEnd: Uint16Array;
  cellX: number;
  cellZ: number;
  filled: boolean;
}

function makeClumpGeometry(bladeHeight: number): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let blade = 0; blade < BLADES_PER_CLUMP; blade++) {
    const around = blade * 2.399 + 0.4;
    const radius = 0.035 + blade * 0.012;
    const bx = Math.cos(around) * radius;
    const bz = Math.sin(around) * radius;
    const facing = around + 1.1 + blade * 0.9;
    const fx = Math.cos(facing);
    const fz = Math.sin(facing);
    const sx = -fz;
    const sz = fx;
    const half = 0.023 + (blade % 2) * 0.005;
    const lean = 0.05 + blade * 0.012;
    const base = positions.length / 3;
    // One tapered triangle per blade: at the fixed camera a blade is 1–2 px wide, so a mid-height bend is invisible.
    positions.push(bx - sx * half, 0, bz - sz * half, bx + sx * half, 0, bz + sz * half, bx + fx * lean, bladeHeight, bz + fz * lean);
    for (let vertex = 0; vertex < 3; vertex++) normals.push(bx * 2, 1, bz * 2);
    indices.push(base, base + 1, base + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * GPU-instanced grass. One shared Lambert material (lights, shadows and fog intact) with
 * per-instance placement/colour attributes, a one-sine vertex-shader wind and a distance fade that shrinks
 * blades to nothing at the edge of the streamed area. Density falls with distance: each tile stores its
 * clumps sorted by a random rank, and the per-frame cull draws only the prefix that can still be alive at the
 * tile's nearest point (the vertex shader applies the same rule per clump). Per-frame work is a uniform write,
 * twelve instance-count writes and, when the focus crosses a tile boundary, refilling recycled tiles in place.
 */
export class GroundGrass {
  readonly group = new Group();
  private readonly material: MeshLambertMaterial;
  private readonly base: BufferGeometry;
  private readonly tiles: Tile[] = [];
  private readonly fade = { value: new Vector4(0, 0, FADE_START, FADE_END) };
  private readonly scratch = createMaskSample();
  private readonly bestDistance = new Float64Array(GRASS_POOL);
  private readonly bestCellX = new Int32Array(GRASS_POOL);
  private readonly bestCellZ = new Int32Array(GRASS_POOL);
  private readonly wanted = new Uint8Array(GRASS_POOL);
  private readonly sortPosition = new Float32Array(GRASS_MAX_CLUMPS_PER_TILE * 4);
  private readonly sortParams = new Float32Array(GRASS_MAX_CLUMPS_PER_TILE * 4);
  private readonly sortBucket = new Uint8Array(GRASS_MAX_CLUMPS_PER_TILE);
  private readonly sortBlight = new Float32Array(GRASS_MAX_CLUMPS_PER_TILE);
  private readonly bucketCursor = new Uint16Array(RANK_BUCKETS);
  private disposed = false;

  private readonly grass: UnderstoryProfile['grass'];

  constructor(private readonly field: TerrainField, private readonly mask: GroundMask, private readonly wind: { value: number }, private readonly understory: UnderstoryProfile) {
    this.grass = understory.grass;
    this.group.name = 'ground-grass';
    this.base = makeClumpGeometry(this.grass.bladeHeight);
    this.material = new MeshLambertMaterial({ color: 0xffffff, side: DoubleSide });
    this.material.name = 'ground-grass';
    this.material.onBeforeCompile = (shader) => this.patchShader(shader);
    this.material.customProgramCacheKey = () => this.grass.cacheKey;
    for (let index = 0; index < GRASS_POOL; index++) {
      const geometry = new InstancedBufferGeometry();
      geometry.index = this.base.index;
      geometry.setAttribute('position', this.base.getAttribute('position'));
      geometry.setAttribute('normal', this.base.getAttribute('normal'));
      const position = new InstancedBufferAttribute(new Float32Array(GRASS_MAX_CLUMPS_PER_TILE * 4), 4).setUsage(DynamicDrawUsage);
      const params = new InstancedBufferAttribute(new Float32Array(GRASS_MAX_CLUMPS_PER_TILE * 4), 4).setUsage(DynamicDrawUsage);
      const blight = new InstancedBufferAttribute(new Float32Array(GRASS_MAX_CLUMPS_PER_TILE), 1).setUsage(DynamicDrawUsage);
      geometry.setAttribute('iPos', position);
      geometry.setAttribute('iParams', params);
      geometry.setAttribute('iBlight', blight);
      geometry.instanceCount = 0;
      geometry.boundingSphere = new Sphere();
      const mesh = new Mesh(geometry, this.material);
      mesh.name = 'ground-grass-tile';
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.frustumCulled = true;
      mesh.visible = false;
      this.group.add(mesh);
      this.tiles.push({ mesh, position, params, blight, bucketEnd: new Uint16Array(RANK_BUCKETS), cellX: 0, cellZ: 0, filled: false });
    }
  }

  /** Draw calls and blades currently submitted (visible tiles only), and what the same tiles would submit without distance thinning. */
  get activeStats(): { tiles: number; blades: number; bladesUnthinned: number } {
    let tiles = 0;
    let blades = 0;
    let bladesUnthinned = 0;
    for (const tile of this.tiles) {
      if (!tile.filled) continue;
      bladesUnthinned += tile.bucketEnd[RANK_BUCKETS - 1]! * BLADES_PER_CLUMP;
      if (!tile.mesh.visible) continue;
      tiles++;
      blades += tile.mesh.geometry.instanceCount * BLADES_PER_CLUMP;
    }
    return { tiles, blades, bladesUnthinned };
  }

  /** Positions of every blade clump currently submitted, for coverage assertions. */
  forEachClump(visit: (x: number, z: number) => void): void {
    for (const tile of this.tiles) {
      if (!tile.mesh.visible) continue;
      const position = tile.position.array as Float32Array;
      for (let index = 0; index < tile.mesh.geometry.instanceCount; index++) visit(position[index * 4]!, position[index * 4 + 2]!);
    }
  }

  /** Streams the tile pool around the focus and thins distant tiles. Allocation-free; refills at most FILLS_PER_FRAME tiles. */
  update(focusX: number, focusZ: number): void {
    if (this.disposed) return;
    const centerX = focusX + VIEW_BIAS_X;
    const centerZ = focusZ + VIEW_BIAS_Z;
    this.fade.value.set(centerX, centerZ, FADE_START, FADE_END);
    const cellX = Math.floor(centerX / GRASS_TILE);
    const cellZ = Math.floor(centerZ / GRASS_TILE);
    let found = 0;
    for (let dz = -WINDOW; dz <= WINDOW; dz++) {
      for (let dx = -WINDOW; dx <= WINDOW; dx++) {
        const cx = cellX + dx;
        const cz = cellZ + dz;
        const rx = Math.max(cx * GRASS_TILE - centerX, 0, centerX - (cx + 1) * GRASS_TILE);
        const rz = Math.max(cz * GRASS_TILE - centerZ, 0, centerZ - (cz + 1) * GRASS_TILE);
        const distance = rx * rx + rz * rz;
        if (found === GRASS_POOL && distance >= this.bestDistance[GRASS_POOL - 1]!) continue;
        let slot = found < GRASS_POOL ? found++ : GRASS_POOL - 1;
        while (slot > 0 && this.bestDistance[slot - 1]! > distance) {
          this.bestDistance[slot] = this.bestDistance[slot - 1]!;
          this.bestCellX[slot] = this.bestCellX[slot - 1]!;
          this.bestCellZ[slot] = this.bestCellZ[slot - 1]!;
          slot--;
        }
        this.bestDistance[slot] = distance;
        this.bestCellX[slot] = cx;
        this.bestCellZ[slot] = cz;
      }
    }
    // Keep tiles whose cell is still wanted; recycle the rest.
    this.wanted.fill(0, 0, found);
    for (const tile of this.tiles) {
      let keep = false;
      for (let slot = 0; slot < found; slot++) {
        if (this.bestCellX[slot] === tile.cellX && this.bestCellZ[slot] === tile.cellZ && tile.filled) {
          this.wanted[slot] = 1;
          keep = true;
          break;
        }
      }
      if (!keep) {
        tile.filled = false;
        tile.mesh.visible = false;
      }
    }
    let fills = 0;
    for (let slot = 0; slot < found && fills < FILLS_PER_FRAME; slot++) {
      if (this.wanted[slot]) continue;
      let tile: Tile | undefined;
      for (const candidate of this.tiles) {
        if (!candidate.filled) {
          tile = candidate;
          break;
        }
      }
      if (!tile) break;
      tile.cellX = this.bestCellX[slot]!;
      tile.cellZ = this.bestCellZ[slot]!;
      this.fill(tile);
      fills++;
    }
    for (const tile of this.tiles) if (tile.filled) this.thin(tile, centerX, centerZ);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const tile of this.tiles) tile.mesh.geometry.dispose();
    this.tiles.length = 0;
    this.base.dispose();
    this.material.dispose();
    this.group.clear();
  }

  /** Draws only the rank prefix that can still be alive at the tile's nearest point to the streaming centre. */
  private thin(tile: Tile, centerX: number, centerZ: number): void {
    const x0 = tile.cellX * GRASS_TILE;
    const z0 = tile.cellZ * GRASS_TILE;
    const rx = Math.max(x0 - centerX, 0, centerX - (x0 + GRASS_TILE));
    const rz = Math.max(z0 - centerZ, 0, centerZ - (z0 + GRASS_TILE));
    const buckets = Math.ceil(grassKeepFraction(Math.hypot(rx, rz)) * RANK_BUCKETS);
    const count = buckets <= 0 ? 0 : tile.bucketEnd[Math.min(buckets, RANK_BUCKETS) - 1]!;
    tile.mesh.geometry.instanceCount = count;
    tile.mesh.visible = count > 0;
  }

  private fill(tile: Tile): void {
    const x0 = tile.cellX * GRASS_TILE;
    const z0 = tile.cellZ * GRASS_TILE;
    const step = GRASS_TILE / GRID;
    const key = Math.imul(tile.cellX, 73856093) ^ Math.imul(tile.cellZ, 19349663);
    const position = this.sortPosition;
    const params = this.sortParams;
    const bucketOf = this.sortBucket;
    const cursor = this.bucketCursor;
    cursor.fill(0);
    let count = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const x = x0 + (i + hash3(i, j, key, SEED)) * step;
        const z = z0 + (j + hash3(i, j, key, SEED + 1)) * step;
        const mask = sampleMask(this.mask, x, z, this.scratch);
        if (hash3(i, j, key, SEED + 2) >= grassDensity(mask, x, z, this.understory)) continue;
        const patch = valueNoise(x * 0.16, z * 0.16, SEED + 9);
        const blight = this.grass.blight ? this.grass.blight.amount(x, z) : 0;
        const rank = hash3(i, j, key, SEED + 7);
        const offset = count * 4;
        position[offset] = x;
        position[offset + 1] = this.field.sample(x, z) - 0.02;
        position[offset + 2] = z;
        position[offset + 3] = hash3(i, j, key, SEED + 3) * Math.PI * 2;
        // Berm tufts grow tall (up to 1.7x) and ignore the shortening applied on the trail and across wide walkable interiors.
        const trodden = Math.max(mask.walk, 0.75 * mask.interior);
        params[offset] = (0.62 + 0.7 * hash3(i, j, key, SEED + 4)) * (0.8 + 0.5 * patch) * (1 - 0.55 * trodden * (1 - mask.edge)) * (1 + 0.7 * mask.edge) * this.grass.heightScale * (1 - (this.grass.blight?.shrink ?? 0) * blight);
        params[offset + 1] = 0.8 + 0.5 * hash3(i, j, key, SEED + 5);
        params[offset + 2] = smoothstep(0.35, 0.75, patch * 0.8 + 0.2 * hash3(i, j, key, SEED + 6));
        params[offset + 3] = rank;
        this.sortBlight[count] = blight;
        const bucket = Math.min(RANK_BUCKETS - 1, Math.floor(rank * RANK_BUCKETS));
        bucketOf[count] = bucket;
        cursor[bucket]!++;
        count++;
      }
    }
    // Counting sort by rank bucket into the tile's GPU arrays.
    let running = 0;
    for (let bucket = 0; bucket < RANK_BUCKETS; bucket++) {
      const size = cursor[bucket]!;
      cursor[bucket] = running;
      running += size;
      tile.bucketEnd[bucket] = running;
    }
    const targetPosition = tile.position.array as Float32Array;
    const targetParams = tile.params.array as Float32Array;
    const targetBlight = tile.blight.array as Float32Array;
    for (let index = 0; index < count; index++) {
      const target = cursor[bucketOf[index]!]!++;
      const slot = target * 4;
      const source = index * 4;
      targetPosition[slot] = position[source]!;
      targetPosition[slot + 1] = position[source + 1]!;
      targetPosition[slot + 2] = position[source + 2]!;
      targetPosition[slot + 3] = position[source + 3]!;
      targetParams[slot] = params[source]!;
      targetParams[slot + 1] = params[source + 1]!;
      targetParams[slot + 2] = params[source + 2]!;
      targetParams[slot + 3] = params[source + 3]!;
      targetBlight[target] = this.sortBlight[index]!;
    }
    tile.position.needsUpdate = true;
    tile.params.needsUpdate = true;
    tile.blight.needsUpdate = true;
    const sphere = tile.mesh.geometry.boundingSphere!;
    sphere.center.set(x0 + GRASS_TILE / 2, 0.4, z0 + GRASS_TILE / 2);
    sphere.radius = GRASS_TILE * Math.SQRT1_2 + 1;
    tile.filled = true;
  }

  private patchShader(shader: WebGLProgramParametersWithUniforms): void {
    shader.uniforms.uWindTime = this.wind;
    shader.uniforms.uFade = this.fade;
    shader.uniforms.uBase = { value: new Color(this.grass.base) };
    shader.uniforms.uTip = { value: new Color(this.grass.tip) };
    shader.uniforms.uBaseDry = { value: new Color(this.grass.baseDry) };
    shader.uniforms.uTipDry = { value: new Color(this.grass.tipDry) };
    shader.uniforms.uBaseBlight = { value: new Color(this.grass.blight?.base ?? this.grass.base) };
    shader.uniforms.uTipBlight = { value: new Color(this.grass.blight?.tip ?? this.grass.tip) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 iPos;
attribute vec4 iParams;
attribute float iBlight;
uniform float uWindTime;
uniform vec4 uFade;
uniform vec3 uBase;
uniform vec3 uTip;
uniform vec3 uBaseDry;
uniform vec3 uTipDry;
uniform vec3 uBaseBlight;
uniform vec3 uTipBlight;
varying vec3 vGrass;`)
      .replace('#include <begin_vertex>', `
float t = position.y * ${(1 / this.grass.bladeHeight).toFixed(4)};
float d = distance(iPos.xz, uFade.xy);
float keep = 1.0 - ${(1 - KEEP_FLOOR).toFixed(2)} * smoothstep(${KEEP_NEAR.toFixed(1)}, ${KEEP_FAR.toFixed(1)}, d);
float hgt = iParams.x * (1.0 - smoothstep(uFade.z, uFade.w, d)) * clamp((keep - iParams.w) * ${(1 / RANK_SOFTNESS).toFixed(1)}, 0.0, 1.0);
float yc = cos(iPos.w);
float ys = sin(iPos.w);
vec3 transformed = vec3(position.x * iParams.y, position.y * hgt, position.z * iParams.y);
transformed.xz = vec2(yc * transformed.x - ys * transformed.z, ys * transformed.x + yc * transformed.z);
float sway = (0.1 + 0.07 * sin(uWindTime * 1.5 + iPos.x * 0.19 + iPos.z * 0.13 + iParams.w * 4.0)) * hgt * t;
transformed.xz += vec2(0.86, 0.5) * sway;
// Blighted blades droop: they lean away along their own heading, more towards the tip.
transformed.xz += vec2(ys, -yc) * iBlight * hgt * t * 0.5;
transformed += iPos.xyz;
vec3 healthy = mix(mix(uBase, uBaseDry, iParams.z), mix(uTip, uTipDry, iParams.z), t);
vGrass = mix(healthy, mix(uBaseBlight, uTipBlight, t), iBlight) * (0.78 + 0.44 * iParams.w) * (0.45 + 0.55 * t);`);
    // Blades are lit by their up-facing normals from both sides; do not flip them on back faces.
    shader.fragmentShader = withCheapShadows(shader.fragmentShader, 'hard')
      .replace('#include <common>', `#include <common>
varying vec3 vGrass;`)
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vGrass;')
      .replace('#include <normal_fragment_begin>', 'vec3 normal = normalize(vNormal); vec3 nonPerturbedNormal = normal;');
  }
}

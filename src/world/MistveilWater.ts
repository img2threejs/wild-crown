import type { GroundCarve, WaterPlan, WaterPoolSpec, WaterRow } from './BiomeProfile';
import { channelSurface, lateralAtLevel, THALWEG } from './GroundCarveShape';
import { smoothstep } from './GroundNoise';

/**
 * Pure geometry of the Mistveil Basin water (no three.js): the Black Sap river that leaves the polluted source north-east of
 * Ghor's arena, runs west behind the extraction site and the foggy glade, and bends south-west past the arrival bank, and the
 * many shallow murky pools scattered through the wetland. The terrain carves all of it, the splat mask paints its banks and
 * bed, the water mesh follows it, and the boundary dressing keeps off it. Every pool and the river lie clear of the
 * walk-mesh: the route never wades.
 *
 * Every channel is a profile across a centreline (flat bed, concave bank, rim reached with zero slope); the river is that
 * profile swept along a smoothed path whose bed, widths and rim height are keyed at its waypoints.
 */
export const MISTVEIL_EXTENT = { minX: -76, maxX: 108, minZ: -58, maxZ: 14 } as const;
export const RIVER_WATER_DEPTH = 0.5;
const SAMPLE_SPACING = 1;
/** Grid cell (m) of the sample lookup; at least the farthest reach of any channel. */
const GRID_CELL = 12;
/** The carve ignores anything farther from a centreline than this many rim half-widths. */
const REACH = 3;
const SUBDIVISIONS = 24;

interface Waypoint {
  readonly x: number;
  readonly z: number;
  /** Bed height (thalweg), flat-bed half width, rim half width, rim height above the bed, and churn 0-1. */
  readonly bed: number;
  readonly bedHalfWidth: number;
  readonly rimHalfWidth: number;
  readonly rimHeight: number;
  readonly turbulence: number;
}
const wp = (x: number, z: number, bed: number, bedHalfWidth: number, rimHalfWidth: number, rimHeight: number, turbulence: number): Waypoint =>
  ({ x, z, bed, bedHalfWidth, rimHalfWidth, rimHeight, turbulence });

/** Flow order: from the source seep at the polluted spring, west past the rig and the glade, then south-west round the arrival bank. */
const RIVER_WAYPOINTS: readonly Waypoint[] = [
  wp(82, -39, -0.55, 1.6, 5.0, 2.6, 0.45),
  wp(70, -45, -0.6, 1.8, 5.5, 2.8, 0.25),
  wp(52, -44, -0.65, 2.0, 5.8, 3.0, 0.15),
  wp(32, -43, -0.7, 2.0, 6.0, 3.0, 0.1),
  wp(12, -48, -0.7, 2.2, 6.2, 3.2, 0.1),
  wp(-10, -47, -0.75, 2.2, 6.2, 3.2, 0.1),
  wp(-32, -43, -0.8, 2.2, 6.2, 3.2, 0.1),
  wp(-52, -41, -0.85, 2.4, 6.4, 3.2, 0.1),
  wp(-68, -42, -0.9, 2.4, 6.4, 3.2, 0.1),
  wp(-80, -42, -0.95, 2.4, 6.4, 3.2, 0.1),
];

export interface Pool {
  readonly x: number;
  readonly z: number;
  /** Water-edge radii along the pool's local axes, rotation (radians), water surface and rim height above the bed. */
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly rotation: number;
  readonly waterY: number;
  readonly rimHeight: number;
  readonly turbulence: number;
}
const pool = (x: number, z: number, radiusX: number, radiusZ: number, rotation: number): Pool =>
  ({ x, z, radiusX, radiusZ, rotation, waterY: -0.1, rimHeight: 1.1, turbulence: 0 });

/** The polluted source: a seep pool where the Black Sap wells up beside Ghor's arena, the head of the river. */
export const SOURCE_POOL: Pool = { x: 86, z: -38, radiusX: 3.8, radiusZ: 3, rotation: 0.3, waterY: -0.3, rimHeight: 1.4, turbulence: 0.5 };

/** Shallow murky dishes in the wetland floor, all outside the walk-mesh (the route stays on dry mud, boardwalk and root). */
export const MIRE_POOLS: readonly Pool[] = [
  pool(-66, 2, 2.8, 2.0, 0.4), pool(-48, 5, 3.0, 2.2, 0.3), pool(-32, 7, 2.4, 1.8, -0.4), pool(-22, -3, 2.6, 2.0, 0.2),
  pool(-10, 4, 3.2, 2.4, 0.5), pool(4, 9, 2.8, 2.0, -0.2), pool(20, 7, 3.2, 2.4, 0.6), pool(36, 6, 2.6, 2.0, 0.1),
  pool(56, 5, 3.0, 2.2, -0.5), pool(72, 6, 3.4, 2.4, 0.3), pool(90, 3, 2.8, 2.0, 0.7), pool(100, -2, 2.6, 1.9, -0.3),
  pool(-26, -29, 2.8, 2.0, 0.4), pool(-22, -37, 2.2, 1.7, -0.2), pool(-4, -37, 2.6, 2.0, 0.5), pool(22, -34, 2.6, 2.0, -0.3),
  pool(60, -34, 2.4, 1.8, 0.2), pool(104, -30, 2.8, 2.0, 0.5), pool(-56, 2, 2.6, 2.0, 0.1),
];
export const POOLS: readonly Pool[] = [SOURCE_POOL, ...MIRE_POOLS];

/** A pool's profile: flat bed 0.5 R, rim 1.5 R (R = mean water radius), bed chosen so the water edge sits at exactly R. */
interface PoolShape {
  readonly pool: Pool;
  readonly mean: number;
  readonly bed: number;
  readonly bedHalfWidth: number;
  readonly rimHalfWidth: number;
  readonly cos: number;
  readonly sin: number;
}
function poolShape(source: Pool): PoolShape {
  const mean = (source.radiusX + source.radiusZ) / 2;
  const bedHalfWidth = 0.5 * mean;
  const rimHalfWidth = 1.5 * mean;
  const edge = channelSurface(mean, 0, bedHalfWidth, rimHalfWidth, source.rimHeight);
  return { pool: source, mean, bed: source.waterY - edge, bedHalfWidth, rimHalfWidth, cos: Math.cos(source.rotation), sin: Math.sin(source.rotation) };
}
const POOL_SHAPES: readonly PoolShape[] = POOLS.map(poolShape);

/** Elliptical distance of (x, z) from a pool centre in metres: R * rho where rho = 1 on the water-edge ellipse. */
function poolDistance(shape: PoolShape, x: number, z: number): number {
  const dx = x - shape.pool.x;
  const dz = z - shape.pool.z;
  const lx = dx * shape.cos + dz * shape.sin;
  const lz = -dx * shape.sin + dz * shape.cos;
  return Math.hypot(lx / shape.pool.radiusX, lz / shape.pool.radiusZ) * shape.mean;
}

export interface RiverSample {
  readonly x: number;
  readonly z: number;
  readonly dirX: number;
  readonly dirZ: number;
  readonly bed: number;
  readonly bedHalfWidth: number;
  readonly rimHalfWidth: number;
  readonly rimHeight: number;
  readonly turbulence: number;
}

interface RiverQuery {
  lateral: number;
  bed: number;
  bedHalfWidth: number;
  rimHalfWidth: number;
  rimHeight: number;
  turbulence: number;
}

/** Uniform Catmull-Rom position and linearly eased channel fields along the waypoints, resampled every SAMPLE_SPACING metres. */
function buildSamples(waypoints: readonly Waypoint[]): RiverSample[] {
  const dense: { x: number; z: number; w: Waypoint; next: Waypoint; u: number }[] = [];
  const at = (index: number): Waypoint => waypoints[Math.max(0, Math.min(waypoints.length - 1, index))]!;
  for (let segment = 0; segment < waypoints.length - 1; segment++) {
    const p0 = at(segment - 1), p1 = at(segment), p2 = at(segment + 1), p3 = at(segment + 2);
    for (let step = 0; step < SUBDIVISIONS; step++) {
      const t = step / SUBDIVISIONS, t2 = t * t, t3 = t2 * t;
      const blend = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push({ x: blend(p0.x, p1.x, p2.x, p3.x), z: blend(p0.z, p1.z, p2.z, p3.z), w: p1, next: p2, u: smoothstep(0, 1, t) });
    }
  }
  const last = waypoints[waypoints.length - 1]!;
  dense.push({ x: last.x, z: last.z, w: last, next: last, u: 0 });
  const cumulative = [0];
  for (let index = 1; index < dense.length; index++) cumulative.push(cumulative[index - 1]! + Math.hypot(dense[index]!.x - dense[index - 1]!.x, dense[index]!.z - dense[index - 1]!.z));
  const length = cumulative[cumulative.length - 1]!;
  const count = Math.max(2, Math.round(length / SAMPLE_SPACING) + 1);
  const samples: RiverSample[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    const arc = (index / (count - 1)) * length;
    while (cursor < dense.length - 2 && cumulative[cursor + 1]! < arc) cursor++;
    const span = cumulative[cursor + 1]! - cumulative[cursor]!;
    const t = span > 0 ? (arc - cumulative[cursor]!) / span : 0;
    const a = dense[cursor]!, b = dense[cursor + 1]!;
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const dirLength = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const u = a.u + (b.u - a.u) * t;
    const from = a.w, to = a.next;
    const mix = (p: number, q: number): number => p + (q - p) * u;
    samples.push({
      x, z, dirX: (b.x - a.x) / dirLength, dirZ: (b.z - a.z) / dirLength,
      bed: mix(from.bed, to.bed), bedHalfWidth: mix(from.bedHalfWidth, to.bedHalfWidth), rimHalfWidth: mix(from.rimHalfWidth, to.rimHalfWidth),
      rimHeight: mix(from.rimHeight, to.rimHeight), turbulence: mix(from.turbulence, to.turbulence),
    });
  }
  return samples;
}

/** The river's centreline samples, 1 m apart in flow order. */
export const RIVER_SAMPLES: readonly RiverSample[] = buildSamples(RIVER_WAYPOINTS);

const cellKey = (cx: number, cz: number): number => (cx + 512) * 4096 + (cz + 512);
const CELLS = new Map<number, number[]>();
RIVER_SAMPLES.forEach((sample, index) => {
  const key = cellKey(Math.floor(sample.x / GRID_CELL), Math.floor(sample.z / GRID_CELL));
  const list = CELLS.get(key);
  if (list) list.push(index);
  else CELLS.set(key, [index]);
});

/** Nearest centreline point: fills `out` with the lateral distance and the interpolated section; false when no sample is near. */
function nearest(x: number, z: number, out: RiverQuery): boolean {
  const cx = Math.floor(x / GRID_CELL), cz = Math.floor(z / GRID_CELL);
  let best = Infinity, bestIndex = -1, bestT = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const list = CELLS.get(cellKey(cx + dx, cz + dz));
      if (!list) continue;
      for (const index of list) {
        for (let offset = -1; offset <= 0; offset++) {
          const start = index + offset;
          if (start < 0 || start >= RIVER_SAMPLES.length - 1) continue;
          const a = RIVER_SAMPLES[start]!, b = RIVER_SAMPLES[start + 1]!;
          const ex = b.x - a.x, ez = b.z - a.z, lengthSquared = ex * ex + ez * ez;
          const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / lengthSquared)) : 0;
          const distance = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
          if (distance < best) { best = distance; bestIndex = start; bestT = t; }
        }
      }
    }
  }
  if (bestIndex < 0) return false;
  const a = RIVER_SAMPLES[bestIndex]!, b = RIVER_SAMPLES[bestIndex + 1]!;
  out.lateral = best;
  out.bed = a.bed + (b.bed - a.bed) * bestT;
  out.bedHalfWidth = a.bedHalfWidth + (b.bedHalfWidth - a.bedHalfWidth) * bestT;
  out.rimHalfWidth = a.rimHalfWidth + (b.rimHalfWidth - a.rimHalfWidth) * bestT;
  out.rimHeight = a.rimHeight + (b.rimHeight - a.rimHeight) * bestT;
  out.turbulence = a.turbulence + (b.turbulence - a.turbulence) * bestT;
  return true;
}

const query: RiverQuery = { lateral: 0, bed: 0, bedHalfWidth: 0, rimHalfWidth: 0, rimHeight: 0, turbulence: 0 };

/** Fills `query` with the river section nearest to (x, z); false beyond the river's reach. */
function riverReaches(x: number, z: number): boolean {
  return nearest(x, z, query) && query.lateral / query.rimHalfWidth <= REACH;
}

/** Water surface height of a river sample. */
export function riverWaterLevelOf(sample: RiverSample): number {
  return sample.bed + RIVER_WATER_DEPTH;
}

/** Half width (m) of the fine-mesh band around the river's waterline. */
const SHORE_BAND = 0.45;
function riverNearShore(): boolean {
  const shore = lateralAtLevel(query.bed + RIVER_WATER_DEPTH, query.bed, query.bedHalfWidth, query.rimHalfWidth, query.rimHeight);
  return Math.abs(query.lateral - shore) <= SHORE_BAND;
}

export const MISTVEIL_CARVE: GroundCarve = {
  lipSmooth: 0.9,
  crestStart: 0.36,
  crestEnd: 1,
  bedNoise: 0.12,
  surfaceHeight(x, z) {
    let height = 100;
    if (riverReaches(x, z)) height = channelSurface(query.lateral, query.bed, query.bedHalfWidth, query.rimHalfWidth, query.rimHeight);
    for (const shape of POOL_SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance > shape.rimHalfWidth * REACH) continue;
      height = Math.min(height, channelSurface(distance, shape.bed, shape.bedHalfWidth, shape.rimHalfWidth, shape.pool.rimHeight));
    }
    return height;
  },
  insideBand(x, z, margin) {
    if (riverReaches(x, z) && riverNearShore()) return true;
    for (const shape of POOL_SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance >= shape.mean * 0.8 - margin && distance <= shape.mean * 1.35 + margin) return true;
    }
    return false;
  },
  membership(x, z) {
    let membership = 0;
    if (riverReaches(x, z)) membership = 1 - smoothstep(query.rimHalfWidth * 0.7, query.rimHalfWidth * 1.35, query.lateral);
    for (const shape of POOL_SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance > shape.rimHalfWidth * 1.4) continue;
      membership = Math.max(membership, 1 - smoothstep(shape.rimHalfWidth * 0.7, shape.rimHalfWidth * 1.35, distance));
    }
    return membership;
  },
  wetness(x, z, surface) {
    let wet = 0;
    if (riverReaches(x, z)) {
      const level = query.bed + RIVER_WATER_DEPTH;
      wet = (1 - smoothstep(query.bedHalfWidth + 0.9, query.bedHalfWidth + 2.6, query.lateral)) * (1 - smoothstep(level + 0.4, level + 1.4, surface));
    }
    for (const shape of POOL_SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance > shape.mean * 1.9) continue;
      const level = shape.pool.waterY;
      // A broad, soft mud margin: the wetland floor is damp round every pool.
      wet = Math.max(wet, (1 - smoothstep(shape.mean * 1.0, shape.mean * 1.7, distance)) * (1 - smoothstep(level + 0.5, level + 1.5, surface)));
    }
    return wet;
  },
  waterLevel(x, z) {
    let level = -Infinity;
    let strength = 0;
    if (riverReaches(x, z)) {
      level = query.bed + RIVER_WATER_DEPTH;
      strength = 1 - smoothstep(query.rimHalfWidth * 0.7, query.rimHalfWidth * 1.35, query.lateral);
    }
    for (const shape of POOL_SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance > shape.rimHalfWidth * 1.4) continue;
      const own = 1 - smoothstep(shape.rimHalfWidth * 0.7, shape.rimHalfWidth * 1.35, distance);
      if (own > strength) { level = shape.pool.waterY; strength = own; }
    }
    return level;
  },
};

/** The river as one strip: a row every `step` samples, fading in at the source and out at the far end; the source churns. */
function riverRows(samples: readonly RiverSample[], fadeIn: number, step: number): WaterRow[] {
  const rows: WaterRow[] = [];
  const count = samples.length;
  const indices: number[] = [];
  for (let index = 0; index < count - 1; index += step) indices.push(index);
  indices.push(count - 1);
  for (const index of indices) {
    const sample = samples[index]!;
    const waterY = riverWaterLevelOf(sample);
    // Where the water meets the bank (carved surface = water level) plus a margin the terrain hides.
    const halfWidth = lateralAtLevel(waterY, sample.bed, sample.bedHalfWidth, sample.rimHalfWidth, sample.rimHeight) + 0.7;
    const fade = smoothstep(0, fadeIn, index) * (1 - smoothstep(count - 8, count - 1, index));
    rows.push({ x: sample.x, z: sample.z, dirX: sample.dirX, dirZ: sample.dirZ, halfWidth, waterY, fade, turbulence: sample.turbulence });
  }
  return rows;
}

/** A pool's water: radii scaled slightly past the water edge (the terrain clips the excess and the alpha is zero where depth is). */
function poolSpec(source: Pool): WaterPoolSpec {
  return { x: source.x, z: source.z, radiusX: source.radiusX * 1.12, radiusZ: source.radiusZ * 1.12, rotation: source.rotation, waterY: source.waterY, turbulence: source.turbulence };
}

/**
 * One palette for all water: murky green-grey in the shallows, deepening to the purple-black of the Black Sap in the river and
 * the source seep, with a dim violet sheen and a faint pale foam.
 */
export const MISTVEIL_WATER: WaterPlan = {
  name: 'mistveil-water',
  strips: [{ rows: riverRows(RIVER_SAMPLES, 4, 2), columns: 21 }],
  pools: POOLS.map(poolSpec),
  palette: { shallow: 0x2f3b36, deep: 0x0b0612, sky: 0x4a4d63, sun: 0x9a8ab0, foam: 0x6d6580 },
  deepDepth: 0.4,
};

/** Smallest distance (m) from (x, z) to the water surface's footprint, negative inside it: used by dressing and tests. */
export function waterMargin(x: number, z: number): number {
  let margin = Infinity;
  if (nearest(x, z, query)) {
    const level = query.bed + RIVER_WATER_DEPTH;
    margin = query.lateral - lateralAtLevel(level, query.bed, query.bedHalfWidth, query.rimHalfWidth, query.rimHeight);
  }
  for (const shape of POOL_SHAPES) margin = Math.min(margin, poolDistance(shape, x, z) - shape.mean);
  return margin;
}

/** The river bed height at the sample nearest (x, z) (the thalweg) when the point is within the river's reach, else undefined. */
export function riverBedAt(x: number, z: number): number | undefined {
  return riverReaches(x, z) ? query.bed + THALWEG : undefined;
}

/**
 * How far (x, z) lies from the nearest channel in units of that channel's rim half width: < 1 inside the banks, about 1 at
 * the rim. Used to keep trees (and anything that needs level ground) off the channel walls.
 */
export function channelReach(x: number, z: number): number {
  let reach = Infinity;
  if (nearest(x, z, query)) reach = query.lateral / query.rimHalfWidth;
  for (const shape of POOL_SHAPES) reach = Math.min(reach, poolDistance(shape, x, z) / shape.rimHalfWidth);
  return reach;
}

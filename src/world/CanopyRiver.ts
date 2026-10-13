import type { GroundCarve, WaterPlan, WaterPoolSpec, WaterRow } from './BiomeProfile';
import { channelSurface, lateralAtLevel, THALWEG } from './GroundCarveShape';
import { smoothstep } from './GroundNoise';

/** Where the waterfall's sheet lands in the plunge pool, at the foot of the west cliff. */
export const WATERFALL_BASE = { x: -68.4, z: -39.5 } as const;

/**
 * Pure geometry of the Whispering Canopy water (no three.js): the river that leaves the waterfall pool, runs south of the
 * basin, north through the gorge under vine bridge A, east north of the roost and down the chasm under vine bridge B as
 * rapids; the plunge pool under the waterfall; and the shallow flooded pools around the temple courtyard. The terrain carves
 * all of it, the splat mask paints its banks and bed, the water mesh follows it, and the boundary dressing keeps off it.
 *
 * Every channel is a profile across a centreline (flat bed, concave bank, rim reached with zero slope); a river is such a
 * profile swept along a smoothed path whose bed, widths and rim height are keyed at its waypoints.
 */
export const RIVER_WATER_DEPTH = 0.5;
/** Radius of the rounded river corners (≥ the widest rim, so the nearest-centreline lookup never flips inside a bend). */
const CORNER_RADIUS = 8;
const SAMPLE_SPACING = 1;
/** Grid cell (m) of the sample lookup; at least the farthest reach of any channel. */
const GRID_CELL = 10;
/** The carve ignores anything farther from a centreline than this many rim half-widths. */
const REACH = 3;

interface Waypoint {
  readonly x: number;
  readonly z: number;
  /** Bed height (thalweg), flat-bed half width, rim half width, rim height above the bed, and rapids turbulence 0–1. */
  readonly bed: number;
  readonly bedHalfWidth: number;
  readonly rimHalfWidth: number;
  readonly rimHeight: number;
  readonly turbulence: number;
  /** Rounded corner here (the path turns through a quarter circle). */
  readonly corner?: boolean;
}

const wp = (x: number, z: number, bed: number, bedHalfWidth: number, rimHalfWidth: number, rimHeight: number, turbulence: number, corner = false): Waypoint =>
  ({ x, z, bed, bedHalfWidth, rimHalfWidth, rimHeight, turbulence, ...(corner ? { corner } : {}) });

/**
 * Flow order. West leg (south from the pool), south-of-basin leg (east), gorge (north, under vine bridge A at z −28.5, deck
 * y 4), north-of-roost leg (east), chasm (south, under vine bridge B at z −23.5, deck y 4, rapids) and on away south.
 * The bed falls all the way downstream; under the bridges it lies 6.7 m (A) and 8.7 m (B) below the decks.
 */
const MAIN_WAYPOINTS: readonly Waypoint[] = [
  wp(-68.5, -35, -1.5, 1.3, 4.0, 3.4, 0.35),
  wp(-70.5, -24, -1.7, 1.5, 4.4, 3.6, 0.2),
  wp(-70.5, -4, -2.0, 1.8, 4.8, 3.8, 0.1, true),
  wp(-9, -4, -2.7, 2.0, 5.2, 7.0, 0.1, true),
  wp(-9, -54, -3.6, 2.0, 5.5, 7.6, 0.25, true),
  wp(18.5, -54, -3.9, 2.2, 5.8, 8.6, 0.3, true),
  wp(18.5, -12, -5.0, 2.3, 5.8, 9.4, 1.0),
  wp(18.5, 12, -5.2, 2.2, 5.4, 8.6, 0.6),
  wp(19.5, 34, -5.4, 2.2, 5.2, 8.0, 0.3),
];

/**
 * The stream that feeds the waterfall: a shallow channel on the cliff-top plateau (y 10.5, flat in the waterfall's corridor)
 * running east to the lip at x ≈ −73, where the sheet starts. Absolute heights: the bed sits 1.1 m under the plateau.
 */
const HEADWATER_WAYPOINTS: readonly Waypoint[] = [
  wp(-100, -39.5, 9.4, 1.5, 3.4, 1.4, 0.2),
  wp(-72.6, -39.5, 9.4, 1.9, 3.8, 1.4, 0.45),
];

interface Pool {
  readonly x: number;
  readonly z: number;
  /** Water-edge radii along the pool's local axes, rotation (radians), water surface and rim height above the bed. */
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly rotation: number;
  readonly waterY: number;
  readonly rimHeight: number;
  readonly turbulence: number;
  /** How much steeper the carve climbs beyond the rim (a plunge pool's wall is a cliff); 1 for a gentle dish. */
  readonly wallSlope?: number;
}

/** The plunge pool under the waterfall: south-west of the basin edge (−64,−31)–(−56,−33)–(−54,−40), never inside the walk-mesh. */
export const PLUNGE_POOL: Pool = { x: -63.5, z: -39.5, radiusX: 6.2, radiusZ: 5.2, rotation: 0.25, waterY: -0.5, rimHeight: 4.8, turbulence: 0.55, wallSlope: 4 };

/** Flooded temple-courtyard pools, outside the walk-mesh: shallow dishes in the valley floor. */
export const COURTYARD_POOLS: readonly Pool[] = [
  { x: 59, z: -30, radiusX: 2.8, radiusZ: 2.0, rotation: 0.4, waterY: -0.1, rimHeight: 1.1, turbulence: 0 },
  { x: 61, z: -21.5, radiusX: 2.2, radiusZ: 3.2, rotation: 0.1, waterY: -0.1, rimHeight: 1.1, turbulence: 0 },
  { x: 36, z: -33.5, radiusX: 2.8, radiusZ: 2.0, rotation: -0.3, waterY: -0.1, rimHeight: 1.1, turbulence: 0 },
  { x: 38.5, z: -8.5, radiusX: 2.8, radiusZ: 2.0, rotation: 0.6, waterY: -0.1, rimHeight: 1.1, turbulence: 0 },
  { x: 55.5, z: -3, radiusX: 2.6, radiusZ: 2.0, rotation: -0.5, waterY: -0.1, rimHeight: 1.1, turbulence: 0 },
];

const POOLS: readonly Pool[] = [PLUNGE_POOL, ...COURTYARD_POOLS];

/** A pool's profile: flat bed 0.5 R̄, rim 1.5 R̄ (R̄ = mean water radius), bed chosen so the water edge sits at exactly R̄. */
interface PoolShape {
  readonly pool: Pool;
  readonly mean: number;
  readonly bed: number;
  readonly bedHalfWidth: number;
  readonly rimHalfWidth: number;
  readonly cos: number;
  readonly sin: number;
}

function poolShape(pool: Pool): PoolShape {
  const mean = (pool.radiusX + pool.radiusZ) / 2;
  const bedHalfWidth = 0.5 * mean;
  const rimHalfWidth = 1.5 * mean;
  // t = (R̄ − bw) / (rw − bw) = 0.5 at the water edge; solve bed so the carved surface there equals the water level.
  const edge = channelSurface(mean, 0, bedHalfWidth, rimHalfWidth, pool.rimHeight);
  return { pool, mean, bed: pool.waterY - edge, bedHalfWidth, rimHalfWidth, cos: Math.cos(pool.rotation), sin: Math.sin(pool.rotation) };
}

const POOL_SHAPES: readonly PoolShape[] = POOLS.map(poolShape);

/** Elliptical distance of (x, z) from a pool centre in metres: R̄·ρ where ρ = 1 on the water-edge ellipse. */
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

function buildPath(waypoints: readonly Waypoint[]): { xs: number[]; zs: number[]; waypointArcs: number[]; cumulative: number[] } {
  const xs: number[] = [];
  const zs: number[] = [];
  const cornerPoint: number[] = [];
  const last = waypoints.length - 1;
  const push = (x: number, z: number): void => {
    xs.push(x);
    zs.push(z);
  };
  for (let index = 0; index <= last; index++) {
    const point = waypoints[index]!;
    if (!point.corner) {
      push(point.x, point.z);
      cornerPoint.push(xs.length - 1);
      continue;
    }
    const before = waypoints[index - 1]!;
    const after = waypoints[index + 1]!;
    const lengthIn = Math.hypot(point.x - before.x, point.z - before.z);
    const lengthOut = Math.hypot(after.x - point.x, after.z - point.z);
    const radius = Math.min(CORNER_RADIUS, lengthIn / 2, lengthOut / 2);
    const ax = point.x - ((point.x - before.x) / lengthIn) * radius;
    const az = point.z - ((point.z - before.z) / lengthIn) * radius;
    const bx = point.x + ((after.x - point.x) / lengthOut) * radius;
    const bz = point.z + ((after.z - point.z) / lengthOut) * radius;
    const steps = 16;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const u = 1 - t;
      push(u * u * ax + 2 * u * t * point.x + t * t * bx, u * u * az + 2 * u * t * point.z + t * t * bz);
      if (step === steps / 2) cornerPoint.push(xs.length - 1);
    }
  }
  const cumulative = [0];
  for (let index = 1; index < xs.length; index++) cumulative.push(cumulative[index - 1]! + Math.hypot(xs[index]! - xs[index - 1]!, zs[index]! - zs[index - 1]!));
  return { xs, zs, waypointArcs: cornerPoint.map((index) => cumulative[index]!), cumulative };
}

class RiverNetwork {
  readonly samples: RiverSample[] = [];
  private readonly cells = new Map<number, number[]>();
  readonly length: number;

  constructor(waypoints: readonly Waypoint[]) {
    const { xs, zs, waypointArcs, cumulative } = buildPath(waypoints);
    const pathLength = xs.length;
    this.length = cumulative[pathLength - 1]!;
    const count = Math.max(2, Math.round(this.length / SAMPLE_SPACING) + 1);
    let segment = 0;
    for (let index = 0; index < count; index++) {
      const arc = (index / (count - 1)) * this.length;
      while (segment < pathLength - 2 && cumulative[segment + 1]! < arc) segment++;
      const span = cumulative[segment + 1]! - cumulative[segment]!;
      const t = span > 0 ? (arc - cumulative[segment]!) / span : 0;
      const x = xs[segment]! + (xs[segment + 1]! - xs[segment]!) * t;
      const z = zs[segment]! + (zs[segment + 1]! - zs[segment]!) * t;
      let dirX = xs[segment + 1]! - xs[segment]!;
      let dirZ = zs[segment + 1]! - zs[segment]!;
      const dirLength = Math.hypot(dirX, dirZ) || 1;
      dirX /= dirLength;
      dirZ /= dirLength;
      let key = 0;
      while (key < waypoints.length - 2 && waypointArcs[key + 1]! < arc) key++;
      const from = waypoints[key]!;
      const to = waypoints[key + 1]!;
      const along = waypointArcs[key + 1]! > waypointArcs[key]! ? smoothstep(waypointArcs[key]!, waypointArcs[key + 1]!, arc) : 0;
      const mix = (a: number, b: number): number => a + (b - a) * along;
      this.samples.push({
        x, z, dirX, dirZ,
        bed: mix(from.bed, to.bed),
        bedHalfWidth: mix(from.bedHalfWidth, to.bedHalfWidth),
        rimHalfWidth: mix(from.rimHalfWidth, to.rimHalfWidth),
        rimHeight: mix(from.rimHeight, to.rimHeight),
        turbulence: mix(from.turbulence, to.turbulence),
      });
    }
    for (let index = 0; index < this.samples.length; index++) {
      const sample = this.samples[index]!;
      const key = this.cellKey(Math.floor(sample.x / GRID_CELL), Math.floor(sample.z / GRID_CELL));
      const list = this.cells.get(key);
      if (list) list.push(index);
      else this.cells.set(key, [index]);
    }
  }

  private cellKey(cx: number, cz: number): number {
    return (cx + 512) * 4096 + (cz + 512);
  }

  /** Nearest centreline point: fills `out` with the lateral distance and the interpolated section; false when no sample is near. */
  nearest(x: number, z: number, out: RiverQuery): boolean {
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    let best = Infinity;
    let bestIndex = -1;
    let bestT = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.cells.get(this.cellKey(cx + dx, cz + dz));
        if (!list) continue;
        for (const index of list) {
          for (let offset = -1; offset <= 0; offset++) {
            const start = index + offset;
            if (start < 0 || start >= this.samples.length - 1) continue;
            const a = this.samples[start]!;
            const b = this.samples[start + 1]!;
            const ex = b.x - a.x;
            const ez = b.z - a.z;
            const lengthSquared = ex * ex + ez * ez;
            const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / lengthSquared)) : 0;
            const distance = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
            if (distance < best) {
              best = distance;
              bestIndex = start;
              bestT = t;
            }
          }
        }
      }
    }
    if (bestIndex < 0) return false;
    const a = this.samples[bestIndex]!;
    const b = this.samples[bestIndex + 1]!;
    out.lateral = best;
    out.bed = a.bed + (b.bed - a.bed) * bestT;
    out.bedHalfWidth = a.bedHalfWidth + (b.bedHalfWidth - a.bedHalfWidth) * bestT;
    out.rimHalfWidth = a.rimHalfWidth + (b.rimHalfWidth - a.rimHalfWidth) * bestT;
    out.rimHeight = a.rimHeight + (b.rimHeight - a.rimHeight) * bestT;
    out.turbulence = a.turbulence + (b.turbulence - a.turbulence) * bestT;
    return true;
  }
}

interface RiverQuery {
  lateral: number;
  bed: number;
  bedHalfWidth: number;
  rimHalfWidth: number;
  rimHeight: number;
  turbulence: number;
}

const NETWORKS: readonly RiverNetwork[] = [new RiverNetwork(MAIN_WAYPOINTS), new RiverNetwork(HEADWATER_WAYPOINTS)];
const query: RiverQuery = { lateral: 0, bed: 0, bedHalfWidth: 0, rimHalfWidth: 0, rimHeight: 0, turbulence: 0 };
const probe: RiverQuery = { lateral: 0, bed: 0, bedHalfWidth: 0, rimHalfWidth: 0, rimHeight: 0, turbulence: 0 };

/** The river's centreline samples, 1 m apart in flow order. */
export const RIVER_SAMPLES: readonly RiverSample[] = NETWORKS[0]!.samples;
/** The headwater stream's centreline samples on the cliff-top plateau. */
export const HEADWATER_SAMPLES: readonly RiverSample[] = NETWORKS[1]!.samples;

/** Water surface height of a river sample. */
export function riverWaterLevelOf(sample: RiverSample): number {
  return sample.bed + RIVER_WATER_DEPTH;
}

/** Fills `query` with the section of the river network whose channel is nearest (in rim half widths) to (x, z); false beyond every reach. */
function riverReaches(x: number, z: number): boolean {
  let bestRatio = Infinity;
  for (const network of NETWORKS) {
    if (!network.nearest(x, z, probe)) continue;
    const ratio = probe.lateral / probe.rimHalfWidth;
    if (ratio >= bestRatio) continue;
    bestRatio = ratio;
    Object.assign(query, probe);
  }
  return bestRatio <= REACH;
}

/** Half width (m) of the fine-mesh band around a river's waterline; the cliff-top headwater (bed above 5 m) stays coarse. */
const SHORE_BAND = 0.6;

/** True within SHORE_BAND of the waterline of the section in `query`: the only place the water's edge needs 0.25 m triangles. */
function riverNearShore(): boolean {
  if (query.bed > 5) return false;
  const shore = lateralAtLevel(query.bed + RIVER_WATER_DEPTH, query.bed, query.bedHalfWidth, query.rimHalfWidth, query.rimHeight);
  return Math.abs(query.lateral - shore) <= SHORE_BAND;
}

export const CANOPY_CARVE: GroundCarve = {
  lipSmooth: 0.9,
  crestStart: 0.36,
  crestEnd: 1,
  bedNoise: 0.16,
  surfaceHeight(x, z) {
    let height = 100;
    if (riverReaches(x, z)) height = channelSurface(query.lateral, query.bed, query.bedHalfWidth, query.rimHalfWidth, query.rimHeight);
    for (const shape of POOL_SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance > shape.rimHalfWidth * REACH) continue;
      height = Math.min(height, channelSurface(distance, shape.bed, shape.bedHalfWidth, shape.rimHalfWidth, shape.pool.rimHeight, shape.pool.wallSlope));
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
      wet = (1 - smoothstep(query.bedHalfWidth + 0.9, query.bedHalfWidth + 2, query.lateral)) * (1 - smoothstep(level + 0.4, level + 1.4, surface));
    }
    for (const shape of POOL_SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance > shape.mean * 1.7) continue;
      const level = shape.pool.waterY;
      wet = Math.max(wet, (1 - smoothstep(shape.mean * 1.0, shape.mean * 1.45, distance)) * (1 - smoothstep(level + 0.5, level + 1.5, surface)));
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
      if (own > strength) {
        level = shape.pool.waterY;
        strength = own;
      }
    }
    return level;
  },
};

/** A river as one strip: a row every `step` samples (1 m apart), fading in at the start and out at the far end; rapids carry turbulence. */
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
function poolSpec(pool: Pool): WaterPoolSpec {
  const spec = { x: pool.x, z: pool.z, radiusX: pool.radiusX * 1.12, radiusZ: pool.radiusZ * 1.12, rotation: pool.rotation, waterY: pool.waterY, turbulence: pool.turbulence };
  return pool === PLUNGE_POOL ? { ...spec, impact: { x: WATERFALL_BASE.x, z: WATERFALL_BASE.z, radius: 4.6 } } : spec;
}

export const CANOPY_WATER: WaterPlan = {
  name: 'canopy-water',
  strips: [{ rows: riverRows(RIVER_SAMPLES, 4, 2), columns: 21 }, { rows: riverRows(HEADWATER_SAMPLES, 6, 2).map((row, index, all) => (index === all.length - 1 ? { ...row, fade: 1 } : row)), columns: 13 }],
  pools: POOLS.map(poolSpec),
  palette: { shallow: 0x3a4a2a, deep: 0x0e2c2a, sky: 0x4b665d, sun: 0xffe0a8, foam: 0xc0ccbd },
  deepDepth: 0.38,
};

/** Smallest distance (m) from (x, z) to the water surface's footprint, negative inside it: used by dressing and tests. */
export function waterMargin(x: number, z: number): number {
  let margin = Infinity;
  for (const network of NETWORKS) {
    if (!network.nearest(x, z, probe)) continue;
    const level = probe.bed + RIVER_WATER_DEPTH;
    margin = Math.min(margin, probe.lateral - lateralAtLevel(level, probe.bed, probe.bedHalfWidth, probe.rimHalfWidth, probe.rimHeight));
  }
  for (const shape of POOL_SHAPES) margin = Math.min(margin, poolDistance(shape, x, z) - shape.mean);
  return margin;
}

/** The river bed height at the sample nearest (x, z) (the thalweg) when the point is within a river's reach, else undefined. */
export function riverBedAt(x: number, z: number): number | undefined {
  return riverReaches(x, z) ? query.bed + THALWEG : undefined;
}

/**
 * How far (x, z) lies from the nearest channel in units of that channel's rim half width: < 1 inside a river's or pool's banks,
 * ~1 at the rim. Used to keep trees (and anything that needs level ground) off the gorge and chasm walls.
 */
export function channelReach(x: number, z: number): number {
  let reach = Infinity;
  for (const network of NETWORKS) {
    if (network.nearest(x, z, probe)) reach = Math.min(reach, probe.lateral / probe.rimHalfWidth);
  }
  for (const shape of POOL_SHAPES) reach = Math.min(reach, poolDistance(shape, x, z) / shape.rimHalfWidth);
  return reach;
}

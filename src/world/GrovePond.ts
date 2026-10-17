import type { GroundCarve, WaterPlan, WaterPoolSpec } from './BiomeProfile';
import { channelSurface } from './GroundCarveShape';
import { smoothstep } from './GroundNoise';

/**
 * Pure geometry of the Grove's two pools (no three.js): the calm pond beside the young Heartroot's mound and the larger Memory Pool
 * behind the boss arena, both shallow dishes carved into the meadow outside the walk-mesh. The terrain carves them, the splat mask
 * paints their banks and beds, the water mesh follows them and the boundary dressing keeps off them. The profile is the same pool
 * section the canopy courtyard pools use (flat bed 0.5 R̄, rim 1.5 R̄).
 */
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

/** The pond: north-east of the glade, between the young Heartroot's mound (west) and the lookout pad (east). */
export const GROVE_POND: Pool = { x: 11, z: -12, radiusX: 4.4, radiusZ: 3, rotation: 0.3, waterY: -0.1, rimHeight: 1.3, turbulence: 0 };
/** The Memory Pool: just north of the boss arena, below the root cavern mouth whose spring feeds it, close enough to stand behind the guardian in the gameplay camera. Its far bank is where the Black Sap seeps in. */
export const MEMORY_POOL: Pool = { x: -24, z: -116, radiusX: 10, radiusZ: 5, rotation: 0, waterY: -0.1, rimHeight: 1.3, turbulence: 0 };

/** Water edge is scaled slightly past the carved water line; the terrain clips the excess and the alpha is zero where depth is. */
const WATER_OVERSCAN = 1.12;
/** The carve ignores anything farther than this many rim half widths. */
const REACH = 3;

interface PoolShape {
  readonly pool: Pool;
  readonly mean: number;
  readonly bedHalfWidth: number;
  readonly rimHalfWidth: number;
  /** Bed height chosen so the carved surface crosses the water level exactly at the mean water radius. */
  readonly bed: number;
  readonly cos: number;
  readonly sin: number;
}

function shapeOf(pool: Pool): PoolShape {
  const mean = (pool.radiusX + pool.radiusZ) / 2;
  const bedHalfWidth = 0.5 * mean;
  const rimHalfWidth = 1.5 * mean;
  return { pool, mean, bedHalfWidth, rimHalfWidth, bed: pool.waterY - channelSurface(mean, 0, bedHalfWidth, rimHalfWidth, pool.rimHeight), cos: Math.cos(pool.rotation), sin: Math.sin(pool.rotation) };
}

const SHAPES: readonly PoolShape[] = [shapeOf(GROVE_POND), shapeOf(MEMORY_POOL)];

/** Elliptical distance of (x, z) from a pool centre in metres: R̄·ρ where ρ = 1 on the water-edge ellipse. */
function poolDistance(shape: PoolShape, x: number, z: number): number {
  const dx = x - shape.pool.x;
  const dz = z - shape.pool.z;
  const lx = dx * shape.cos + dz * shape.sin;
  const lz = -dx * shape.sin + dz * shape.cos;
  return Math.hypot(lx / shape.pool.radiusX, lz / shape.pool.radiusZ) * shape.mean;
}

export const GROVE_CARVE: GroundCarve = {
  lipSmooth: 0.9,
  crestStart: 0.36,
  crestEnd: 1,
  bedNoise: 0.1,
  surfaceHeight(x, z) {
    let best = 100;
    for (const shape of SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance <= shape.rimHalfWidth * REACH) best = Math.min(best, channelSurface(distance, shape.bed, shape.bedHalfWidth, shape.rimHalfWidth, shape.pool.rimHeight));
    }
    return best;
  },
  insideBand(x, z, margin) {
    return SHAPES.some(shape => {
      const distance = poolDistance(shape, x, z);
      return distance >= shape.mean * 0.8 - margin && distance <= shape.mean * 1.35 + margin;
    });
  },
  membership(x, z) {
    let best = 0;
    for (const shape of SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance <= shape.rimHalfWidth * 1.4) best = Math.max(best, 1 - smoothstep(shape.rimHalfWidth * 0.7, shape.rimHalfWidth * 1.35, distance));
    }
    return best;
  },
  wetness(x, z, surface) {
    let best = 0;
    for (const shape of SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance > shape.mean * 1.7) continue;
      best = Math.max(best, (1 - smoothstep(shape.mean * 1.0, shape.mean * 1.45, distance)) * (1 - smoothstep(shape.pool.waterY + 0.5, shape.pool.waterY + 1.5, surface)));
    }
    return best;
  },
  waterLevel(x, z) {
    for (const shape of SHAPES) {
      const distance = poolDistance(shape, x, z);
      if (distance <= shape.rimHalfWidth * 1.4 && 1 - smoothstep(shape.rimHalfWidth * 0.7, shape.rimHalfWidth * 1.35, distance) > 0) return shape.pool.waterY;
    }
    return -Infinity;
  },
};

const poolSpec = (pool: Pool): WaterPoolSpec => ({
  x: pool.x, z: pool.z, radiusX: pool.radiusX * WATER_OVERSCAN, radiusZ: pool.radiusZ * WATER_OVERSCAN,
  rotation: pool.rotation, waterY: pool.waterY, turbulence: pool.turbulence,
});

export const GROVE_WATER: WaterPlan = {
  name: 'grove-water',
  strips: [],
  pools: [poolSpec(GROVE_POND), poolSpec(MEMORY_POOL)],
  // Warm, shallow, clear water: golden-green shallows over a deep teal centre that mirrors the late-afternoon sky.
  palette: { shallow: 0x6d8f4c, deep: 0x1f4f48, sky: 0x9cc0a8, sun: 0xffd89a, foam: 0xeef2d6 },
  deepDepth: 0.45,
};

/** Smallest distance (m) from (x, z) to the nearest water surface's footprint, negative inside it: used by dressing and tests. */
export function waterMargin(x: number, z: number): number {
  return Math.min(...SHAPES.map(shape => poolDistance(shape, x, z) - shape.mean));
}

/** How far (x, z) lies from the nearest pool in units of its rim half width: < 1 inside the banks, ~1 at the rim. */
export function channelReach(x: number, z: number): number {
  return Math.min(...SHAPES.map(shape => poolDistance(shape, x, z) / shape.rimHalfWidth));
}

/** Mean water radius (m) of the pond and of the Memory Pool, exported for tests and dressing. */
export const POND_MEAN_RADIUS = SHAPES[0]!.mean;
export const MEMORY_POOL_MEAN_RADIUS = SHAPES[1]!.mean;

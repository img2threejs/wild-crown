import type { GroundCarve, WaterPlan, WaterPoolSpec } from './BiomeProfile';
import { channelSurface } from './GroundCarveShape';
import { smoothstep } from './GroundNoise';

/**
 * Pure geometry of the Grove's pond (no three.js): a calm, shallow dish carved into the meadow beside the young Heartroot's mound,
 * outside the walk-mesh. The terrain carves it, the splat mask paints its banks and bed, the water mesh follows it and the
 * boundary dressing keeps off it. The profile is the same pool section the canopy courtyard pools use (flat bed 0.5 R̄, rim 1.5 R̄).
 */
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
}

/** The pond: north-east of the glade, between the young Heartroot's mound (west) and the north trail (east). */
export const GROVE_POND: Pool = { x: 11, z: -12, radiusX: 4.4, radiusZ: 3, rotation: 0.3, waterY: -0.1, rimHeight: 1.3, turbulence: 0 };

/** Water edge is scaled slightly past the carved water line; the terrain clips the excess and the alpha is zero where depth is. */
const WATER_OVERSCAN = 1.12;
/** The carve ignores anything farther than this many rim half widths. */
const REACH = 3;

const mean = (GROVE_POND.radiusX + GROVE_POND.radiusZ) / 2;
const bedHalfWidth = 0.5 * mean;
const rimHalfWidth = 1.5 * mean;
/** Bed height chosen so the carved surface crosses the water level exactly at the mean water radius. */
const bed = GROVE_POND.waterY - channelSurface(mean, 0, bedHalfWidth, rimHalfWidth, GROVE_POND.rimHeight);
const cos = Math.cos(GROVE_POND.rotation);
const sin = Math.sin(GROVE_POND.rotation);

/** Elliptical distance of (x, z) from the pond centre in metres: R̄·ρ where ρ = 1 on the water-edge ellipse. */
function poolDistance(x: number, z: number): number {
  const dx = x - GROVE_POND.x;
  const dz = z - GROVE_POND.z;
  const lx = dx * cos + dz * sin;
  const lz = -dx * sin + dz * cos;
  return Math.hypot(lx / GROVE_POND.radiusX, lz / GROVE_POND.radiusZ) * mean;
}

export const GROVE_CARVE: GroundCarve = {
  lipSmooth: 0.9,
  crestStart: 0.36,
  crestEnd: 1,
  bedNoise: 0.1,
  surfaceHeight(x, z) {
    const distance = poolDistance(x, z);
    return distance > rimHalfWidth * REACH ? 100 : channelSurface(distance, bed, bedHalfWidth, rimHalfWidth, GROVE_POND.rimHeight);
  },
  insideBand(x, z, margin) {
    const distance = poolDistance(x, z);
    return distance >= mean * 0.8 - margin && distance <= mean * 1.35 + margin;
  },
  membership(x, z) {
    const distance = poolDistance(x, z);
    return distance > rimHalfWidth * 1.4 ? 0 : 1 - smoothstep(rimHalfWidth * 0.7, rimHalfWidth * 1.35, distance);
  },
  wetness(x, z, surface) {
    const distance = poolDistance(x, z);
    if (distance > mean * 1.7) return 0;
    return (1 - smoothstep(mean * 1.0, mean * 1.45, distance)) * (1 - smoothstep(GROVE_POND.waterY + 0.5, GROVE_POND.waterY + 1.5, surface));
  },
  waterLevel(x, z) {
    const distance = poolDistance(x, z);
    if (distance > rimHalfWidth * 1.4) return -Infinity;
    return 1 - smoothstep(rimHalfWidth * 0.7, rimHalfWidth * 1.35, distance) > 0 ? GROVE_POND.waterY : -Infinity;
  },
};

const POND_SPEC: WaterPoolSpec = {
  x: GROVE_POND.x, z: GROVE_POND.z, radiusX: GROVE_POND.radiusX * WATER_OVERSCAN, radiusZ: GROVE_POND.radiusZ * WATER_OVERSCAN,
  rotation: GROVE_POND.rotation, waterY: GROVE_POND.waterY, turbulence: GROVE_POND.turbulence,
};

export const GROVE_WATER: WaterPlan = {
  name: 'grove-water',
  strips: [],
  pools: [POND_SPEC],
  // Warm, shallow, clear water: golden-green shallows over a deep teal centre that mirrors the late-afternoon sky.
  palette: { shallow: 0x6d8f4c, deep: 0x1f4f48, sky: 0x9cc0a8, sun: 0xffd89a, foam: 0xeef2d6 },
  deepDepth: 0.45,
};

/** Smallest distance (m) from (x, z) to the water surface's footprint, negative inside it: used by dressing and tests. */
export function waterMargin(x: number, z: number): number {
  return poolDistance(x, z) - mean;
}

/** How far (x, z) lies from the pond in units of its rim half width: < 1 inside the banks, ~1 at the rim. */
export function channelReach(x: number, z: number): number {
  return poolDistance(x, z) / rimHalfWidth;
}

/** Mean water radius (m), exported for tests and dressing. */
export const POND_MEAN_RADIUS = mean;

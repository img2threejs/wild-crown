import type { GroundCarve, SummitSpec } from './BiomeProfile.js';
import { distanceToSegment, insidePolygon } from './GreenwakeBoundary.js';
import { channelSurface } from './GroundCarveShape.js';
import { fbm, smoothstep, valueNoise } from './GroundNoise.js';

/**
 * Pure geometry of the Moonpine Ridge ground (no three.js): the temple massif, the cold mountains behind the route, the frozen
 * lake north of the shore shelf and the gorge under the log bridge. The terrain raises and carves all of it, the splat mask paints
 * it, the ice feature draws the lake and the boundary dressing keeps off it. Everything here is presentational: the walk-mesh in
 * `MoonpineTrialRegion` stays the only authority for walkability.
 */

// ---- summits: the temple massif and the stair slope ----

/**
 * Planar, non-walkable raised ground that continues the walkable planes: the hillside the temple stair climbs (the plane matches
 * the ramp exactly, y = (x - 24) / 3) and the plateau around the temple terrace, so the buried temple stands in the mountain.
 */
export const MOONPINE_SUMMITS: readonly SummitSpec[] = [
  { id: 'moonpine-massif-stair', hummock: 0.3, points: [{ x: 24, y: 0, z: -35 }, { x: 36, y: 4, z: -35 }, { x: 36, y: 4, z: -9 }, { x: 24, y: 0, z: -9 }] },
  { id: 'moonpine-massif-temple', hummock: 0.35, points: [{ x: 36, y: 4, z: -62 }, { x: 62, y: 4, z: -62 }, { x: 62, y: 4, z: -11 }, { x: 36, y: 4, z: -11 }] },
];

const BACKDROP_SEED = 4417;

/**
 * Far relief that makes the valley read as the foot of cold mountains: a slope north of the route (the temple ridge, rising
 * towards the east) and a shoulder west of the trail. Both stand behind the route as seen from the fixed camera.
 */
export function moonpineBackdrop(x: number, z: number): number {
  const north = smoothstep(-50, -66, z);
  const west = smoothstep(-76, -90, x) * smoothstep(-10, -30, z);
  const fraction = 1 - (1 - north) * (1 - west);
  if (fraction <= 0) return 0;
  const crag = fbm(x / 3.1, z / 3.1, BACKDROP_SEED, 2) * 0.9 * Math.min(1, 4 * fraction * (1 - fraction));
  const swell = 1 + 0.12 * (valueNoise(x * 0.09, z * 0.09, BACKDROP_SEED + 1) - 0.5);
  const base = (10 + 7 * smoothstep(10, 58, x)) * north + 9 * west * (1 - north);
  return base * swell + crag + 1.4 * fbm(x / 13, z / 13, BACKDROP_SEED + 2, 2) * fraction;
}

/** How far (m) from a massif's raised ground a trunk must stand to find level ground: faces fall away over about this much. */
export const FACE_REACH = 5.5;

/** Whether (x, z) lies inside a summit and its distance (m) to the nearest summit boundary. */
export function summitEdgeDistance(x: number, z: number): { inside: boolean; distance: number } {
  let best = Infinity;
  let inside = false;
  for (const summit of MOONPINE_SUMMITS) {
    const points = summit.points;
    if (insidePolygon(points, x, z)) inside = true;
    for (let index = 0; index < points.length; index++) best = Math.min(best, distanceToSegment(x, z, points[index]!, points[(index + 1) % points.length]!));
  }
  return { inside, distance: best };
}

/** Steepness of the open-ground backdrop at (x, z) (rise per metre), for keeping trees off the mountain walls. */
export function backdropSlope(x: number, z: number): number {
  const step = 0.5;
  return Math.hypot(moonpineBackdrop(x + step, z) - moonpineBackdrop(x - step, z), moonpineBackdrop(x, z + step) - moonpineBackdrop(x, z - step)) / (2 * step);
}

// ---- the frozen lake ----

/** Walk-surface material of the lake shelf: the ice feature draws the sheet over every surface that carries it. */
export const MOONPINE_LAKE_MATERIAL = 'moonpine-frozen-lake';

/** The lake's mean ellipse (north of the shore shelf, at the foot of the mountains); the shoreline wobbles around it. */
export const LAKE = { x: -46, z: -40, radiusX: 20, radiusZ: 12 } as const;
/** Metres of ice above the dish floor under it: the ice sheet is drawn at y = 0 and the dish lies below. */
const LAKE_FLOOR = -1.4;
const LAKE_FLOOR_RUN = 7;

/** Shoreline radius factor around the lake at `angle` (radians): ±12 % in a few low harmonics, so the shore is never a clean ellipse. */
export function lakeWobble(angle: number): number {
  return 1 + 0.07 * Math.sin(3 * angle + 0.7) + 0.05 * Math.sin(5 * angle + 2.1);
}

/** Signed distance (m, approximate) from (x, z) to the lake shore: negative on the ice, 0 on the shore, positive on the land. */
export function lakeDistance(x: number, z: number): number {
  const dx = x - LAKE.x;
  const dz = z - LAKE.z;
  const rho = Math.hypot(dx / LAKE.radiusX, dz / LAKE.radiusZ);
  return (rho / lakeWobble(Math.atan2(dz, dx)) - 1) * Math.min(LAKE.radiusX, LAKE.radiusZ);
}

/** Plan-view outline of the walkable lake shelf (the Frozen Shore arena): apothem 10 m around (-46, -22); the region's lake-shelf surface is built from it. */
export const MOONPINE_SHELF: readonly { readonly x: number; readonly z: number }[] = [
  { x: -56, z: -27 }, { x: -50, z: -33 }, { x: -42, z: -33 }, { x: -36, z: -27 }, { x: -36, z: -17 }, { x: -42, z: -11 }, { x: -50, z: -11 }, { x: -56, z: -17 },
];

/** True on the ice sheet: inside the lake shoreline or on the shelf. Ground cover and clutter never grow there. */
export function onMoonpineIce(x: number, z: number): boolean {
  return lakeDistance(x, z) < 0.4 || insidePolygon(MOONPINE_SHELF, x, z);
}

/** The lake's shoreline as a closed polygon of `count` points (counter-clockwise in x, z), pushed out by `outset` metres. */
export function lakeOutline(count: number, outset = 0): { x: number; z: number }[] {
  const points: { x: number; z: number }[] = [];
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2;
    const wobble = lakeWobble(angle);
    points.push({ x: LAKE.x + Math.cos(angle) * (LAKE.radiusX * wobble + outset), z: LAKE.z + Math.sin(angle) * (LAKE.radiusZ * wobble + outset) });
  }
  return points;
}

// ---- the gorge under the log bridge ----

/** The gorge runs north-south through x = -9, between the shore path (west) and the hollow (east); the bridge spans it at z = -22. */
export const GORGE_X = -9;
const GORGE_BED = -7;
const GORGE_BED_HALF = 2;
export const GORGE_RIM_HALF = 5.2;
const GORGE_RIM_HEIGHT = 7.3;
/** Metres above the bed at which the frozen creek lies. */
export const GORGE_ICE_DEPTH = 0.5;
/** The gorge is carved over z -46…14 and climbs out of the ground towards both ends. */
const gorgeDepth = (z: number): number => smoothstep(-70, -46, z) * (1 - smoothstep(14, 36, z));
const gorgeBed = (z: number): number => { const depth = gorgeDepth(z); return GORGE_BED * depth + (1 - depth); };

/** Distance from the gorge centreline in units of its rim half width, and 0 where the gorge has climbed out of the ground. */
export function gorgeReach(x: number, z: number): number {
  return gorgeDepth(z) > 0.05 ? Math.abs(x - GORGE_X) / GORGE_RIM_HALF : Infinity;
}

/** Height of the frozen creek surface at the bottom of the gorge at z. */
export function gorgeIceLevel(z: number): number { return gorgeBed(z) + GORGE_ICE_DEPTH; }

/** Width of the band (z, m) around the bridge in which the gorge is meshed finely. */
const GORGE_BAND = { minZ: -34, maxZ: -10 };
/** Fine-mesh band around the lake shore (m). */
const SHORE_BAND = 1.4;

export const MOONPINE_CARVE: GroundCarve = {
  lipSmooth: 0.9,
  crestStart: 0.36,
  crestEnd: 1,
  bedNoise: 0.16,
  surfaceHeight(x, z) {
    let height = 100;
    const lateral = Math.abs(x - GORGE_X);
    if (lateral < GORGE_RIM_HALF * 3 && gorgeDepth(z) > 0) height = channelSurface(lateral, gorgeBed(z), GORGE_BED_HALF, GORGE_RIM_HALF, GORGE_RIM_HEIGHT);
    const shore = lakeDistance(x, z);
    if (shore < LAKE_FLOOR_RUN + 4) {
      // The dish under the ice: its floor lies 1.4 m below the sheet, rising to the shoreline, then a gentle bank into the ground.
      const dish = shore <= 0 ? LAKE_FLOOR + -LAKE_FLOOR * smoothstep(-LAKE_FLOOR_RUN, 0, shore) : 0.5 * shore;
      height = Math.min(height, dish);
    }
    return height;
  },
  insideBand(x, z, margin) {
    if (Math.abs(lakeDistance(x, z)) <= SHORE_BAND + margin) return true;
    const lateral = Math.abs(x - GORGE_X);
    return z >= GORGE_BAND.minZ - margin && z <= GORGE_BAND.maxZ + margin && gorgeDepth(z) > 0.2 && Math.abs(lateral - GORGE_RIM_HALF * 0.65) <= GORGE_RIM_HALF * 0.55 + margin;
  },
  membership(x, z) {
    const depth = smoothstep(0.35, 0.8, gorgeDepth(z));
    return depth * (1 - smoothstep(GORGE_RIM_HALF * 0.7, GORGE_RIM_HALF * 1.35, Math.abs(x - GORGE_X)));
  },
  wetness(x, z, surface) {
    const depth = smoothstep(0.35, 0.8, gorgeDepth(z));
    if (depth <= 0) return 0;
    const lateral = Math.abs(x - GORGE_X);
    const level = gorgeIceLevel(z);
    return depth * (1 - smoothstep(GORGE_BED_HALF + 0.9, GORGE_BED_HALF + 2.4, lateral)) * (1 - smoothstep(level + 0.4, level + 1.6, surface));
  },
  waterLevel(x, z) {
    if (gorgeDepth(z) < 0.4 || Math.abs(x - GORGE_X) > GORGE_RIM_HALF * 1.4) return -Infinity;
    return gorgeIceLevel(z);
  },
};

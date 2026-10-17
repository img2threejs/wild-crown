import type { SummitSpec } from './BiomeProfile';
import { distanceToSegment, insidePolygon } from './GreenwakeBoundary';
import { fbm, smoothstep, valueNoise } from './GroundNoise';

/**
 * Pure geometry of the Whispering Canopy cliff massif (no three.js): the terrain raises it, the splat mask paints it as rock and
 * the boundary dressing reads it to keep trees off cliff faces.
 *
 * Planar, non-walkable raised ground around the walkable cliff tops and slopes, so the y 4 tops are the summits of a rock massif
 * and the root stair and the temple descent climb its flanks. The planes match the walkables' planes exactly (ramps are
 * y = 4(x + 36)/12 and y = 4 − 4(x − 24)/14); the gorge and the chasm cut through the plateaus.
 */
export const CANOPY_SUMMITS: readonly SummitSpec[] = [
  // Root-stair slope, flanking the ramp.
  { id: 'canopy-massif-stair', hummock: 0.3, points: [{ x: -36, y: 0, z: -37 }, { x: -24, y: 4, z: -37 }, { x: -24, y: 4, z: -19 }, { x: -36, y: 0, z: -19 }] },
  // Fig-ledge plateau (the gorge's west wall).
  { id: 'canopy-massif-fig', hummock: 0.35, points: [{ x: -24, y: 4, z: -40 }, { x: -11, y: 4, z: -40 }, { x: -11, y: 4, z: -18 }, { x: -24, y: 4, z: -18 }] },
  // Roost plateau (the gorge's east wall and the chasm's west wall).
  { id: 'canopy-massif-roost', hummock: 0.4, points: [{ x: -7, y: 4, z: -44 }, { x: 14, y: 4, z: -44 }, { x: 16, y: 4, z: -24 }, { x: 14, y: 4, z: -10 }, { x: -7, y: 4, z: -10 }] },
  // Temple-descent slope (the chasm's east wall).
  { id: 'canopy-massif-descent', hummock: 0.3, points: [{ x: 24, y: 4, z: -34 }, { x: 38, y: 0, z: -34 }, { x: 38, y: 0, z: -11 }, { x: 24, y: 4, z: -11 }] },
];

const BACKDROP_SEED = 8821;

/**
 * Far relief that makes the valley read as the foot of a rainforest massif: a 10.5 m rock wall west of the plunge pool (the
 * waterfall's cliff, a ~11 m fall into the pool) and a 9 m slope north of the route. Both stand behind the route as seen from
 * the fixed camera, never in front. The plateau around the waterfall's headwater stays calm (no hummocks) so its stream bed
 * (y 9.4) always lies under the ground (y 10.5).
 */
export function canopyBackdrop(x: number, z: number): number {
  const west = smoothstep(-70.5, -73, x) * smoothstep(-22, -34, z);
  const north = smoothstep(-47, -61, z) * smoothstep(86, 72, x);
  const fraction = 1 - (1 - west) * (1 - north);
  if (fraction <= 0) return 0;
  const corridor = (1 - smoothstep(3.5, 9, Math.abs(z + 39.5))) * smoothstep(-70, -76, x);
  const rough = 1 - corridor;
  const crag = fbm(x / 2.6, z / 2.6, BACKDROP_SEED, 2) * 0.85 * Math.min(1, 4 * fraction * (1 - fraction)) * rough;
  const swell = 1 + 0.1 * (valueNoise(x * 0.11, z * 0.11, BACKDROP_SEED + 1) - 0.5) * rough;
  const base = 10.5 * west + 9 * north * (1 - west);
  return base * swell + crag + 1.6 * fbm(x / 13, z / 13, BACKDROP_SEED + 2, 2) * fraction * rough;
}

/** How far (m) from the massif's raised ground a tree trunk must stand to find level ground: faces fall away over about this much. */
export const FACE_REACH = 5.5;

/**
 * Whether (x, z) lies inside a cliff summit (a level plateau or a planar slope) and its distance (m) to that summit's boundary,
 * the nearest one when outside every summit: callers tell level cliff tops (inside, away from the edge) from faces (near the edge).
 */
export function summitEdgeDistance(x: number, z: number): { inside: boolean; distance: number } {
  let best = Infinity;
  let inside = false;
  for (const summit of CANOPY_SUMMITS) {
    const points = summit.points;
    if (insidePolygon(points, x, z)) inside = true;
    for (let index = 0; index < points.length; index++) best = Math.min(best, distanceToSegment(x, z, points[index]!, points[(index + 1) % points.length]!));
  }
  return { inside, distance: best };
}

/** Steepness of the open-ground backdrop at (x, z) (rise per metre), for keeping trees off the cliff walls. */
export function backdropSlope(x: number, z: number): number {
  const step = 0.5;
  return Math.hypot(canopyBackdrop(x + step, z) - canopyBackdrop(x - step, z), canopyBackdrop(x, z + step) - canopyBackdrop(x, z - step)) / (2 * step);
}

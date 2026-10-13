import { GROVE_BOUNDARY_ID_PREFIX } from '../game/combat/GroveContent.js';
import type { RegionDefinition, Vec3, WorldAssetPlacement } from '../game/contracts.js';
import {
  distanceToBoxFootprint,
  distanceToPolygon,
  distanceToSegment,
  outwardCameraDot,
  polygonArea,
  TREE_CAMERA_DOT,
  type BoundaryKeepClear,
  type FootprintCircle,
  type Point,
} from './GreenwakeBoundary.js';
import { mulberry32 } from './GroundNoise.js';
import { channelReach, GROVE_POND, waterMargin } from './GrovePond.js';
import { groveBackdrop, HEARTROOT_MOUND } from './GroveTerrain.js';

export { GROVE_BOUNDARY_ID_PREFIX };
/** Boulder placements: ids `grove-boundary-rock-<n>`; they stand on the lowest ground under their footprint (RegionEnvironment). */
export const GROVE_BOUNDARY_ROCK_ID_PREFIX = GROVE_BOUNDARY_ID_PREFIX + 'rock-';
/** Minimum clear distance between any boundary footprint circle and a walkable surface. */
export const GROVE_BOUNDARY_CLEARANCE = 0.8;
/** Radius around the stage goal ring (2.2 m) that stays free of boundary props. */
export const GROVE_EXIT_CLEAR_RADIUS = 4.5;
/** Trees keep this far (centre to exit) from the goal, so the trailhead reads as a sunlit clearing. */
export const GROVE_EXIT_TREE_CLEARING = 11;

const TREE = 'prop-erya-edge-tree';
const ROCK = 'prop-greenwake-boulder-cluster';
const FERN = 'prop-canopy-fern-cluster';
/** The prop assets boundary dressing may use (the whole boundary prop set of the Grove). */
export const GROVE_BOUNDARY_ASSET_IDS: readonly string[] = [TREE, ROCK, FERN];

// Conservative plan-view radii (m) at placement scale 1: the Erya edge tree (as in the Greenwake boundary), a ~3 m boulder cluster
// and a ~2.4 m fern clump (manifest transforms normalise the models to these).
const TREE_RADIUS = 3.25;
const ROCK_RADIUS = 1.5;
const FERN_RADIUS = 1.2;
/** Dressing further than this from every route anchor is never visible during play and is skipped. */
const ROUTE_VISIBILITY_RANGE = 25;
const TREE_VISIBILITY_RANGE = 36;
/** Edges whose outward normal faces the camera more than this receive only low props (ferns, small boulders). */
const CAMERA_FACING = 0.15;
const CAMERA_FACING_RANGE = 14;
const CAMERA_FACING_FERN_DISTANCE = 4;
const CAMERA_FACING_FERN_SCALE = 0.6;
/** Anything standing on level ground stays this many rim half widths from the pond (except bank dressing); trees keep a wider margin. */
const CHANNEL_REACH_LIMIT = 1.3;
const TREE_WATER_MARGIN = 3;
const TREE_MAX_SLOPE = 0.5;
/** The young Heartroot's mound and its trunk stay free of dressing within this radius. */
const MOUND_CLEAR_RADIUS = HEARTROOT_MOUND.radius + 1;
const SEED = 0x6a07e5;
/** Grid cells (m) of the meadow-edge tree fill and the fern fill. */
const FILL_TREE_CELL = 10;
const FILL_FERN_CELL = 4.6;

interface Polygon { readonly points: readonly Point[] }

/** Plan-view circle that conservatively covers a placement's visible volume. */
export function groveFootprint(assetId: string, position: Readonly<Vec3>, scale: Readonly<Vec3>): FootprintCircle {
  const unit = assetId === TREE ? TREE_RADIUS : assetId === ROCK ? ROCK_RADIUS : FERN_RADIUS;
  return { x: position.x, z: position.z, radius: unit * Math.max(scale.x, scale.z) };
}

/** Steepness of the open-ground relief at (x, z) (rise per metre), for keeping trees off slopes. */
function reliefSlope(x: number, z: number): number {
  const step = 0.5;
  return Math.hypot(groveBackdrop(x + step, z) - groveBackdrop(x - step, z), groveBackdrop(x, z + step) - groveBackdrop(x, z - step)) / (2 * step);
}

/**
 * Deterministic dressing that frames the meadow so it reads as a sheltered sanctuary: low ferns and boulders along every
 * walkable edge, a ring of ferns and a few boulders round the pond's bank and the young Heartroot's mound, and Erya trees behind
 * the edges that face away from the gameplay camera (never on camera-facing ones, so the Warden stays visible). Every
 * footprint circle stays at least {@link GROVE_BOUNDARY_CLEARANCE} from every walkable, off the water, clear of gate boxes, arenas,
 * the goal ring and authored set dressing. Placements add no simulation colliders.
 */
export function buildGroveBoundaryPlacements(region: RegionDefinition, keepClear: BoundaryKeepClear = { gates: [], arenas: [] }): WorldAssetPlacement[] {
  const walkable: Polygon[] = [];
  for (const surface of region.ground.surfaces) {
    if (!surface.walkable) continue;
    const points = surface.points.map(point => ({ x: point.x, z: point.z }));
    if (polygonArea(points) < 0) points.reverse();
    walkable.push({ points });
  }
  const exit = region.exits[0]?.from;
  const routeSegments: [Point, Point][] = [];
  for (const ribbon of region.navigation.ribbons) {
    for (let index = 1; index < ribbon.points.length; index++) routeSegments.push([ribbon.points[index - 1]!, ribbon.points[index]!]);
  }
  if (exit) routeSegments.push([exit, exit]);
  const visibleFromRoute = (x: number, z: number, range: number): boolean => routeSegments.some(([a, b]) => distanceToSegment(x, z, a, b) <= range);

  const random = mulberry32(SEED);
  const between = (min: number, max: number): number => min + (max - min) * random();
  const placements: WorldAssetPlacement[] = [];
  const placed: FootprintCircle[] = [];
  const counters = { tree: 0, rock: 0, fern: 0 };

  /** Everything every kind must respect; `bank` placements deliberately stand beside the water. */
  const clear = (circle: FootprintCircle, bank: boolean, range: number): boolean => {
    for (const polygon of walkable) if (distanceToPolygon(polygon.points, circle.x, circle.z) < circle.radius + GROVE_BOUNDARY_CLEARANCE) return false;
    for (const gate of keepClear.gates) if (distanceToBoxFootprint(gate, circle.x, circle.z) < circle.radius + 0.5) return false;
    for (const arena of keepClear.arenas) if (Math.hypot(circle.x - arena.center.x, circle.z - arena.center.z) < arena.radius + circle.radius + 0.5) return false;
    if (exit && Math.hypot(circle.x - exit.x, circle.z - exit.z) < (circle.radius > 2.5 ? GROVE_EXIT_TREE_CLEARING : GROVE_EXIT_CLEAR_RADIUS + circle.radius)) return false;
    for (const obstacle of keepClear.obstacles ?? []) if (Math.hypot(circle.x - obstacle.x, circle.z - obstacle.z) < 0.6 * (obstacle.radius + circle.radius)) return false;
    if (Math.hypot(circle.x - HEARTROOT_MOUND.x, circle.z - HEARTROOT_MOUND.z) < MOUND_CLEAR_RADIUS + circle.radius * 0.5) return false;
    if (waterMargin(circle.x, circle.z) < 0.4 + 0.5 * circle.radius) return false;
    if (!bank && channelReach(circle.x, circle.z) < CHANNEL_REACH_LIMIT) return false;
    for (const other of placed) if (Math.hypot(circle.x - other.x, circle.z - other.z) < 0.5 * (circle.radius + other.radius)) return false;
    return visibleFromRoute(circle.x, circle.z, range);
  };

  const distanceToWalkable = (x: number, z: number): number => {
    let best = Infinity;
    for (const polygon of walkable) best = Math.min(best, distanceToPolygon(polygon.points, x, z));
    return best;
  };

  const add = (assetId: string, kind: 'tree' | 'rock' | 'fern', x: number, z: number, requestedScale: number, bank = false): boolean => {
    let scale = requestedScale;
    // Edges whose outward normal faces the camera: no boulders or trees at all, and only small ferns (scale <= 0.6) at least 4 m
    // from the walk-mesh, so nothing big fills the lower-right of the screen.
    if (outwardCameraDot(walkable, x, z) > CAMERA_FACING && distanceToWalkable(x, z) < CAMERA_FACING_RANGE) {
      if (kind !== 'fern' || distanceToWalkable(x, z) < CAMERA_FACING_FERN_DISTANCE) return false;
      scale = Math.min(scale, CAMERA_FACING_FERN_SCALE);
    }
    const position = { x, y: 0, z };
    const scales = { x: scale, y: scale * (kind === 'fern' ? between(0.9, 1.3) : kind === 'rock' ? between(0.8, 1.15) : 1), z: scale };
    const circle = groveFootprint(assetId, position, scales);
    if (!clear(circle, bank, kind === 'tree' ? TREE_VISIBILITY_RANGE : ROUTE_VISIBILITY_RANGE)) return false;
    placed.push(circle);
    placements.push({ id: `${GROVE_BOUNDARY_ID_PREFIX}${kind}-${counters[kind]++}`, assetId, position, rotationY: random() * Math.PI * 2, scale: scales, placement: 'ground' });
    return true;
  };

  /** Level ground for a trunk: well clear of the mound, the pond and every slope of the far relief. */
  const levelGround = (x: number, z: number, radius: number): boolean => reliefSlope(x, z) <= TREE_MAX_SLOPE && waterMargin(x, z) >= TREE_WATER_MARGIN + radius;

  // 1. Low dressing along every walkable edge: ferns, boulders (small facing the camera, larger behind).
  walkable.forEach((polygon) => {
    const { points } = polygon;
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const direction = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
      // The polygon is counter-clockwise in (x, z), so outward is to the right of travel.
      const normal = { x: direction.z, z: -direction.x };
      const facing = normal.x * 0.5812 + normal.z * 0.8137 > CAMERA_FACING;
      for (let distance = between(0.4, 2.2); distance < length - 0.2; distance += between(3, 5.2)) {
        const base = { x: a.x + direction.x * distance, z: a.z + direction.z * distance };
        const wantRock = random() < (facing ? 0.2 : 0.35);
        for (let attempt = 0; attempt < 2; attempt++) {
          const scale = wantRock ? (facing ? between(0.45, 0.7) : between(0.7, 1.2)) : between(0.75, 1.3);
          const radius = (wantRock ? ROCK_RADIUS : FERN_RADIUS) * scale;
          const offset = GROVE_BOUNDARY_CLEARANCE + radius + 0.1 + between(0, 0.9) + attempt * 0.9;
          if (add(wantRock ? ROCK : FERN, wantRock ? 'rock' : 'fern', base.x + normal.x * offset, base.z + normal.z * offset, scale)) break;
        }
      }
    }
  });

  // 2. The pond's bank: ferns all round and a few boulders, standing just above the waterline.
  for (let step = 0; step < 16; step++) {
    const angle = (step / 16) * Math.PI * 2 + between(-0.15, 0.15);
    const kind = step % 4 === 3;
    const scale = kind ? between(0.5, 0.8) : between(0.8, 1.2);
    const reach = kind ? 1.35 : 1.3 + 0.1 * random();
    add(kind ? ROCK : FERN, kind ? 'rock' : 'fern', GROVE_POND.x + Math.cos(angle) * GROVE_POND.radiusX * reach, GROVE_POND.z + Math.sin(angle) * GROVE_POND.radiusZ * reach, scale, true);
  }

  // 3. Round the young Heartroot's mound: a loose ring of ferns and two or three boulders at its foot.
  for (let step = 0; step < 14; step++) {
    const angle = (step / 14) * Math.PI * 2 + between(-0.2, 0.2);
    const kind = step % 5 === 4;
    const scale = kind ? between(0.6, 0.9) : between(0.8, 1.2);
    const ring = HEARTROOT_MOUND.radius + 1.6 + between(0, 1.4);
    add(kind ? ROCK : FERN, kind ? 'rock' : 'fern', HEARTROOT_MOUND.x + Math.cos(angle) * ring, HEARTROOT_MOUND.z + Math.sin(angle) * ring, scale);
  }

  // 4. Erya trees behind edges that face away from the camera: an outer ring on level ground.
  walkable.forEach((polygon) => {
    const { points } = polygon;
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const direction = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
      const normal = { x: direction.z, z: -direction.x };
      if (normal.x * 0.5812 + normal.z * 0.8137 >= 0) continue;
      for (let distance = between(0.5, 5); distance < length - 0.2; distance += between(8, 13)) {
        const scale = between(0.55, 0.85);
        const radius = TREE_RADIUS * scale;
        for (let attempt = 0; attempt < 3; attempt++) {
          const offset = GROVE_BOUNDARY_CLEARANCE + radius + 2.5 + between(0, 5) + attempt * 3;
          const x = a.x + direction.x * distance + normal.x * offset;
          const z = a.z + direction.z * distance + normal.z * offset;
          if (outwardCameraDot(walkable, x, z) > TREE_CAMERA_DOT || !levelGround(x, z, radius)) continue;
          if (add(TREE, 'tree', x, z, scale)) break;
        }
      }
    }
  });

  // 5. Meadow fill: sparse trees on a jittered grid on level ground behind the route (never camera-facing), then fern clumps between
  // everything within reach of the route, so no bare ground shows past the dressing along the edges.
  const extent = { minX: -64, maxX: 56, minZ: -78, maxZ: 62 };
  for (let z = extent.minZ; z < extent.maxZ; z += FILL_TREE_CELL) {
    for (let x = extent.minX; x < extent.maxX; x += FILL_TREE_CELL) {
      const tx = x + between(0, FILL_TREE_CELL);
      const tz = z + between(0, FILL_TREE_CELL);
      const scale = between(0.55, 0.9);
      if (random() < 0.4 || outwardCameraDot(walkable, tx, tz) > TREE_CAMERA_DOT || !levelGround(tx, tz, TREE_RADIUS * scale)) continue;
      add(TREE, 'tree', tx, tz, scale);
    }
  }
  for (let z = extent.minZ; z < extent.maxZ; z += FILL_FERN_CELL) {
    for (let x = extent.minX; x < extent.maxX; x += FILL_FERN_CELL) {
      const fx = x + between(0, FILL_FERN_CELL);
      const fz = z + between(0, FILL_FERN_CELL);
      const scale = between(0.8, 1.3);
      if (random() < 0.5) continue;
      add(FERN, 'fern', fx, fz, scale);
    }
  }
  return placements;
}

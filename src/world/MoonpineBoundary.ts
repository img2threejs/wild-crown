import type { RegionDefinition, Vec3, WorldAssetPlacement } from '../game/contracts.js';
import { MOONPINE_BOUNDARY_ID_PREFIX } from '../game/combat/MoonpineContent.js';
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
import { backdropSlope, FACE_REACH, gorgeReach, LAKE, lakeDistance, lakeWobble, MOONPINE_SUMMITS, summitEdgeDistance } from './MoonpineTerrain.js';
import { isBridgeDeckSurface } from './WalkSurfaces.js';

/** Snow-rock placements: ids `moonpine-boundary-rock-<n>`; they stand on the lowest ground under their footprint (RegionEnvironment). */
export const MOONPINE_BOUNDARY_ROCK_ID_PREFIX = MOONPINE_BOUNDARY_ID_PREFIX + 'rock-';
/** Minimum clear distance between any boundary footprint circle and a walkable surface or bridge deck. */
export const MOONPINE_BOUNDARY_CLEARANCE = 0.8;
/** Radius around the stage goal ring (2.2 m) that stays free of low boundary props. */
export const MOONPINE_EXIT_CLEAR_RADIUS = 4.5;
/** Pines keep this far (centre to exit) from the goal, so the exit reads as a clearing in the pine forest. */
export const MOONPINE_EXIT_TREE_CLEARING = 12;

const PINE = 'prop-moonpine-tree';
const ROCK = 'prop-snow-ridge-rock';
/** The prop assets boundary dressing may use (with the temple, the chain anchors and the log bridge, the whole prop set of the region). */
export const MOONPINE_BOUNDARY_ASSET_IDS: readonly string[] = [PINE, ROCK];

// Conservative plan-view radii (m) at placement scale 1: a 16 m pine with a ~6 m crown, a 5 m wide snow rock.
const PINE_RADIUS = 3;
const ROCK_RADIUS = 2.5;
/** Dressing further than this from every route anchor is never visible during play and is skipped. */
const ROUTE_VISIBILITY_RANGE = 25;
/** Pines (16 m tall) show above the horizon of the fixed camera from much farther away. */
const TREE_VISIBILITY_RANGE = 40;
/** Edges whose outward normal faces the camera more than this receive only small rocks, never pines. */
const CAMERA_FACING = 0.15;
/** Camera-facing rule applies within this distance of the walk-mesh. */
const CAMERA_FACING_RANGE = 14;
const GORGE_REACH_LIMIT = 1.3;
const LAKE_TREE_MARGIN = 3;
const TREE_MAX_SLOPE = 0.55;
const SEED = 0x3b17e55;
const FILL_TREE_CELL = 5.5;

interface Polygon { readonly points: readonly Point[] }

/** Plan-view circle that conservatively covers a placement's visible volume. */
export function moonpineFootprint(assetId: string, position: Readonly<Vec3>, scale: Readonly<Vec3>): FootprintCircle {
  const unit = assetId === PINE ? PINE_RADIUS : ROCK_RADIUS;
  return { x: position.x, z: position.z, radius: unit * Math.max(scale.x, scale.z) };
}

/**
 * Deterministic dressing that frames the sealed route as a snowy pine forest at the foot of cold mountains: snow rocks along every
 * walkable edge, the lake shore, the gorge rim and the massif faces, and pines behind the edges that face away from the gameplay
 * camera (never on the camera-facing ones, so Aren stays visible). Every footprint circle stays at least
 * {@link MOONPINE_BOUNDARY_CLEARANCE} from every walkable surface and bridge deck, off the ice, clear of gate boxes, arenas, the goal
 * ring and authored set dressing, and never on massif faces or gorge walls. Placements add no simulation colliders.
 */
export function buildMoonpineBoundaryPlacements(region: RegionDefinition, keepClear: BoundaryKeepClear = { gates: [], arenas: [] }): WorldAssetPlacement[] {
  const walkable: Polygon[] = [];
  const edgePolygons: Polygon[] = [];
  for (const surface of region.ground.surfaces) {
    if (!surface.walkable) continue;
    const points = surface.points.map(point => ({ x: point.x, z: point.z }));
    if (polygonArea(points) < 0) points.reverse();
    walkable.push({ points });
    // The log bridge spans the gorge: no dressing along its sides (it would hang over the void).
    if (!isBridgeDeckSurface(surface)) edgePolygons.push({ points });
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
  const counters = { tree: 0, rock: 0 };

  /** Everything every kind must respect; `shore` placements deliberately stand beside the ice or the gorge. */
  const clear = (circle: FootprintCircle, tree: boolean, shore: boolean, range: number): boolean => {
    for (const polygon of walkable) if (distanceToPolygon(polygon.points, circle.x, circle.z) < circle.radius + MOONPINE_BOUNDARY_CLEARANCE) return false;
    for (const gate of keepClear.gates) if (distanceToBoxFootprint(gate, circle.x, circle.z) < circle.radius + 0.5) return false;
    for (const arena of keepClear.arenas) if (Math.hypot(circle.x - arena.center.x, circle.z - arena.center.z) < arena.radius + circle.radius + 0.5) return false;
    if (exit && Math.hypot(circle.x - exit.x, circle.z - exit.z) < (tree ? MOONPINE_EXIT_TREE_CLEARING : MOONPINE_EXIT_CLEAR_RADIUS + circle.radius)) return false;
    for (const obstacle of keepClear.obstacles ?? []) if (Math.hypot(circle.x - obstacle.x, circle.z - obstacle.z) < 0.6 * (obstacle.radius + circle.radius)) return false;
    if (lakeDistance(circle.x, circle.z) < 0.4 + 0.5 * circle.radius) return false;
    if (!shore && gorgeReach(circle.x, circle.z) < GORGE_REACH_LIMIT) return false;
    for (const other of placed) if (Math.hypot(circle.x - other.x, circle.z - other.z) < 0.5 * (circle.radius + other.radius)) return false;
    return visibleFromRoute(circle.x, circle.z, range);
  };

  const distanceToWalkable = (x: number, z: number): number => {
    let best = Infinity;
    for (const polygon of walkable) best = Math.min(best, distanceToPolygon(polygon.points, x, z));
    return best;
  };

  const add = (kind: 'tree' | 'rock', x: number, z: number, requestedScale: number, shore = false): boolean => {
    // Edges whose outward normal faces the camera: no pines at all, and only small rocks at least 4 m from the walk-mesh.
    if (outwardCameraDot(edgePolygons, x, z) > CAMERA_FACING && distanceToWalkable(x, z) < CAMERA_FACING_RANGE) {
      if (kind === 'tree' || distanceToWalkable(x, z) < 4) return false;
    }
    const assetId = kind === 'tree' ? PINE : ROCK;
    const position = { x, y: 0, z };
    const scales = { x: requestedScale, y: requestedScale * (kind === 'rock' ? between(0.8, 1.15) : 1), z: requestedScale };
    const circle = moonpineFootprint(assetId, position, scales);
    if (!clear(circle, kind === 'tree', shore, kind === 'tree' ? TREE_VISIBILITY_RANGE : ROUTE_VISIBILITY_RANGE)) return false;
    placed.push(circle);
    placements.push({ id: `${MOONPINE_BOUNDARY_ID_PREFIX}${kind}-${counters[kind]++}`, assetId, position, rotationY: random() * Math.PI * 2, scale: scales, placement: 'ground' });
    return true;
  };

  /** Level ground for a pine trunk: inside a plateau away from its edge, or well clear of every massif face, gorge wall and the lake. */
  const levelGround = (x: number, z: number, radius: number): boolean => {
    const summit = summitEdgeDistance(x, z);
    if (summit.inside ? summit.distance < radius + 1.5 : summit.distance < radius + FACE_REACH) return false;
    return backdropSlope(x, z) <= TREE_MAX_SLOPE && lakeDistance(x, z) >= LAKE_TREE_MARGIN + radius;
  };

  // 1. Snow rocks along every walkable edge: small on the camera-facing sides, bigger behind.
  edgePolygons.forEach(polygon => {
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
      for (let distance = between(0.8, 3); distance < length - 0.2; distance += between(4.5, 8)) {
        if (random() < (facing ? 0.55 : 0.3)) continue;
        const base = { x: a.x + direction.x * distance, z: a.z + direction.z * distance };
        for (let attempt = 0; attempt < 2; attempt++) {
          const scale = facing ? between(0.3, 0.5) : between(0.4, 0.9);
          const offset = MOONPINE_BOUNDARY_CLEARANCE + ROCK_RADIUS * scale + 0.1 + between(0, 1) + attempt * 1.2;
          if (add('rock', base.x + normal.x * offset, base.z + normal.z * offset, scale)) break;
        }
      }
    }
  });

  // 2. Rocks on the massif's faces (they stand on the lowest ground under their footprint, partly sunk into the slope).
  for (const summit of MOONPINE_SUMMITS) {
    const points: Point[] = summit.points.map(point => ({ x: point.x, z: point.z }));
    if (polygonArea(points) < 0) points.reverse();
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const direction = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
      const normal = { x: direction.z, z: -direction.x };
      const facing = normal.x * 0.5812 + normal.z * 0.8137 > CAMERA_FACING;
      for (let distance = between(0.5, 3); distance < length - 0.4; distance += between(5, 8)) {
        const scale = facing ? between(0.3, 0.5) : between(0.6, 1.1);
        const offset = ROCK_RADIUS * scale * 0.5 + between(0.4, 2);
        add('rock', a.x + direction.x * distance + normal.x * offset, a.z + direction.z * distance + normal.z * offset, scale);
      }
    }
  }

  // 3. The lake shore: boulders half sunk at the waterline all round, and a few on the ice-side banks near the shelf.
  for (let step = 0; step < 36; step++) {
    const angle = (step / 36) * Math.PI * 2 + between(-0.05, 0.05);
    const scale = between(0.4, 0.85);
    const wobble = lakeWobble(angle);
    const reach = 1.12 + 0.06 * random();
    add('rock', LAKE.x + Math.cos(angle) * LAKE.radiusX * wobble * reach, LAKE.z + Math.sin(angle) * LAKE.radiusZ * wobble * reach, scale, true);
  }

  // 4. The gorge rim: boulders along both lips, every ~6 m, standing on the rim itself.
  for (let z = -46; z < 14; z += between(5, 7)) {
    for (const side of [-1, 1]) {
      if (random() < 0.3) continue;
      add('rock', -9 + side * (5.2 + between(0.8, 2.2)), z, between(0.4, 0.8), true);
    }
  }

  // 5. Pines behind edges that face away from the camera: an outer ring on level ground.
  edgePolygons.forEach(polygon => {
    const { points } = polygon;
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const direction = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
      const normal = { x: direction.z, z: -direction.x };
      if (normal.x * 0.5812 + normal.z * 0.8137 >= 0) continue;
      for (let distance = between(0.5, 4); distance < length - 0.2; distance += between(6, 9)) {
        const scale = between(0.6, 1);
        const radius = PINE_RADIUS * scale;
        for (let attempt = 0; attempt < 3; attempt++) {
          const offset = MOONPINE_BOUNDARY_CLEARANCE + radius + 2 + between(0, 4) + attempt * 3;
          const x = a.x + direction.x * distance + normal.x * offset;
          const z = a.z + direction.z * distance + normal.z * offset;
          if (outwardCameraDot(edgePolygons, x, z) > TREE_CAMERA_DOT || !levelGround(x, z, radius)) continue;
          if (add('tree', x, z, scale)) break;
        }
      }
    }
  });

  // 6. Pine forest fill: pines on a jittered grid across level ground behind the route (never camera-facing).
  const extent = { minX: -90, maxX: 70, minZ: -68, maxZ: 26 };
  for (let z = extent.minZ; z < extent.maxZ; z += FILL_TREE_CELL) {
    for (let x = extent.minX; x < extent.maxX; x += FILL_TREE_CELL) {
      const tx = x + between(0, FILL_TREE_CELL);
      const tz = z + between(0, FILL_TREE_CELL);
      const scale = between(0.6, 1.05);
      if (random() < 0.1 || outwardCameraDot(edgePolygons, tx, tz) > TREE_CAMERA_DOT || !levelGround(tx, tz, PINE_RADIUS * scale)) continue;
      add('tree', tx, tz, scale);
    }
  }
  return placements;
}

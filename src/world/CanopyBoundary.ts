import type { RegionDefinition, Vec3, WorldAssetPlacement } from '../game/contracts.js';
import { backdropSlope, CANOPY_SUMMITS, FACE_REACH, summitEdgeDistance } from './CanopyMassif.js';
import { channelReach, COURTYARD_POOLS, PLUNGE_POOL, RIVER_SAMPLES, RIVER_WATER_DEPTH, waterMargin } from './CanopyRiver.js';
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
import { lateralAtLevel } from './GroundCarveShape.js';
import { mulberry32 } from './GroundNoise.js';
import { isBridgeDeckSurface } from './WalkSurfaces.js';

/** Boundary placements are visual only; solid-props.ts classifies this id prefix as 'decoration' (no colliders). */
export const CANOPY_BOUNDARY_ID_PREFIX = 'canopy-boundary-';
/** Cliff-rock placements: ids `canopy-boundary-rock-<n>`; they stand on the lowest ground under their footprint. */
export const CANOPY_BOUNDARY_ROCK_ID_PREFIX = CANOPY_BOUNDARY_ID_PREFIX + 'rock-';
/** Minimum clear distance between any boundary footprint circle and a walkable surface or bridge deck (the contract asks ≥ 0.6 m). */
export const CANOPY_BOUNDARY_CLEARANCE = 0.8;
/** Radius around the stage goal ring (2.2 m) that stays free of boundary props. */
export const CANOPY_EXIT_CLEAR_RADIUS = 4.5;
/** Giant trees stay this far (centre to exit) from the goal, so the exit reads as a clearing with the sun reaching the path. */
export const CANOPY_EXIT_TREE_CLEARING = 14;

const TREE = 'prop-rainforest-canopy-tree';
const ROCK = 'prop-canopy-cliff-rock';
const FERN = 'prop-canopy-fern-cluster';
/** The prop assets boundary dressing may use (with the shrine and the vine bridges, the whole prop set of the canopy region). */
export const CANOPY_BOUNDARY_ASSET_IDS: readonly string[] = [TREE, ROCK, FERN];

// Conservative plan-view radii (m) at placement scale 1. The tree matches CanopyTrialRegion's authored-tree footprint; the rock is a
// ~3.6 m wide basalt outcrop, the fern cluster a ~2.4 m wide clump (manifest transforms normalise the generated models to these).
const TREE_RADIUS = 4;
const ROCK_RADIUS = 1.8;
const FERN_RADIUS = 1.2;
/** Dressing further than this from every route anchor is never visible during play and is skipped. */
const ROUTE_VISIBILITY_RANGE = 25;
/** Giant trees (22 m tall) show above the horizon of the fixed camera from much farther away. */
const TREE_VISIBILITY_RANGE = 40;
/** Edges whose outward normal faces the camera more than this receive only low props (ferns, small rocks). */
const CAMERA_FACING = 0.15;
/** Camera-facing rule applies within this distance of the walk-mesh; ferns there keep ≥ 4 m away and stay ≤ 0.6 scale. */
const CAMERA_FACING_RANGE = 14;
const CAMERA_FACING_FERN_DISTANCE = 4;
const CAMERA_FACING_FERN_SCALE = 0.6;
/** Channels: anything standing on level ground stays this many rim half widths from a river or pool; trees also keep dry. */
const CHANNEL_REACH_LIMIT = 1.3;
const TREE_WATER_MARGIN = 3;
const TREE_MAX_SLOPE = 0.55;
const SEED = 0x2c0ffee;
/** Grid cells (m) of the jungle fill. */
const FILL_TREE_CELL = 9;
const FILL_FERN_CELL = 4.2;

interface Polygon {
  readonly points: readonly Point[];
}

/** Plan-view circle that conservatively covers a placement's visible volume. */
export function canopyFootprint(assetId: string, position: Readonly<Vec3>, scale: Readonly<Vec3>): FootprintCircle {
  const unit = assetId === TREE ? TREE_RADIUS : assetId === ROCK ? ROCK_RADIUS : FERN_RADIUS;
  return { x: position.x, z: position.z, radius: unit * Math.max(scale.x, scale.z) };
}

/**
 * Deterministic dressing that frames the sealed route so it reads as dense jungle: low ferns and cliff rocks along every walkable
 * edge and cliff crest, larger rocks on the massif's faces, rocks on the river's banks and around the plunge pool and the
 * flooded courtyard pools, and giant rainforest trees behind the edges that face away from the gameplay camera (never on the
 * camera-facing ones, so Aren stays visible). Every footprint circle stays ≥ {@link CANOPY_BOUNDARY_CLEARANCE} from every
 * walkable surface and bridge deck, off the water, clear of gate boxes, arenas, the goal ring and authored set dressing, and
 * never on cliff faces or channel walls. Placements add no simulation colliders.
 */
export function buildCanopyBoundaryPlacements(region: RegionDefinition, keepClear: BoundaryKeepClear = { gates: [], arenas: [] }): WorldAssetPlacement[] {
  const walkable: Polygon[] = [];
  const edgePolygons: Polygon[] = [];
  for (const surface of region.ground.surfaces) {
    if (!surface.walkable) continue;
    const points = surface.points.map(point => ({ x: point.x, z: point.z }));
    if (polygonArea(points) < 0) points.reverse();
    walkable.push({ points });
    // Bridge decks span the gorge and the chasm: no dressing along their sides (it would hang over the void).
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
  const counters = { tree: 0, rock: 0, fern: 0 };

  /** Everything every kind must respect; `bank` placements deliberately stand beside the water. */
  const clear = (circle: FootprintCircle, bank: boolean, range: number): boolean => {
    for (const polygon of walkable) if (distanceToPolygon(polygon.points, circle.x, circle.z) < circle.radius + CANOPY_BOUNDARY_CLEARANCE) return false;
    for (const gate of keepClear.gates) if (distanceToBoxFootprint(gate, circle.x, circle.z) < circle.radius + 0.5) return false;
    for (const arena of keepClear.arenas) if (Math.hypot(circle.x - arena.center.x, circle.z - arena.center.z) < arena.radius + circle.radius + 0.5) return false;
    // Giant trees keep a wide clearing around the exit (their canopy shades the goal ring); low dressing keeps the 4.5 m ring.
    if (exit && Math.hypot(circle.x - exit.x, circle.z - exit.z) < (circle.radius > 2.5 ? CANOPY_EXIT_TREE_CLEARING : CANOPY_EXIT_CLEAR_RADIUS + circle.radius)) return false;
    for (const obstacle of keepClear.obstacles ?? []) if (Math.hypot(circle.x - obstacle.x, circle.z - obstacle.z) < 0.6 * (obstacle.radius + circle.radius)) return false;
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
    // Edges whose outward normal faces the camera (same rule as Greenwake): no rocks or trees at all, and only small ferns
    // (scale ≤ 0.6) at least 4 m from the walk-mesh, so nothing big and dark fills the lower-right of the screen.
    if (outwardCameraDot(edgePolygons, x, z) > CAMERA_FACING && distanceToWalkable(x, z) < CAMERA_FACING_RANGE) {
      if (kind !== 'fern' || distanceToWalkable(x, z) < CAMERA_FACING_FERN_DISTANCE) return false;
      scale = Math.min(scale, CAMERA_FACING_FERN_SCALE);
    }
    const position = { x, y: 0, z };
    const scales = { x: scale, y: scale * (kind === 'fern' ? between(0.9, 1.3) : kind === 'rock' ? between(0.8, 1.15) : 1), z: scale };
    const circle = canopyFootprint(assetId, position, scales);
    if (!clear(circle, bank, kind === 'tree' ? TREE_VISIBILITY_RANGE : ROUTE_VISIBILITY_RANGE)) return false;
    placed.push(circle);
    placements.push({ id: `${CANOPY_BOUNDARY_ID_PREFIX}${kind}-${counters[kind]++}`, assetId, position, rotationY: random() * Math.PI * 2, scale: scales, placement: 'ground' });
    return true;
  };

  /** Level ground for a giant trunk: inside a plateau away from its edge, or well clear of every cliff face and wall. */
  const levelGround = (x: number, z: number, radius: number): boolean => {
    const summit = summitEdgeDistance(x, z);
    if (summit.inside ? summit.distance < radius + 1.5 : summit.distance < radius + FACE_REACH) return false;
    return backdropSlope(x, z) <= TREE_MAX_SLOPE && waterMargin(x, z) >= TREE_WATER_MARGIN + radius;
  };

  // 1. Low dressing along every walkable edge and cliff crest: ferns, small rocks facing the camera, bigger ones behind.
  edgePolygons.forEach((polygon) => {
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
      for (let distance = between(0.4, 2.2); distance < length - 0.2; distance += between(2.6, 4.6)) {
        const base = { x: a.x + direction.x * distance, z: a.z + direction.z * distance };
        const wantRock = random() < (facing ? 0.3 : 0.55);
        for (let attempt = 0; attempt < 2; attempt++) {
          const scale = wantRock ? (facing ? between(0.45, 0.7) : between(0.8, 1.45)) : between(0.75, 1.3);
          const radius = (wantRock ? ROCK_RADIUS : FERN_RADIUS) * scale;
          const offset = CANOPY_BOUNDARY_CLEARANCE + radius + 0.1 + between(0, 0.9) + attempt * 0.9;
          if (add(wantRock ? ROCK : FERN, wantRock ? 'rock' : 'fern', base.x + normal.x * offset, base.z + normal.z * offset, scale)) break;
        }
      }
    }
  });

  // 2. Rocks on the massif's faces (they stand on the lowest ground under their footprint, so partly sunk into the slope).
  for (const summit of CANOPY_SUMMITS) {
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
      for (let distance = between(0.5, 2.5); distance < length - 0.4; distance += between(3, 5.5)) {
        const scale = facing ? between(0.5, 0.8) : between(0.9, 1.5);
        const offset = ROCK_RADIUS * scale * 0.5 + between(0.4, 1.8);
        add(ROCK, 'rock', a.x + direction.x * distance + normal.x * offset, a.z + direction.z * distance + normal.z * offset, scale);
      }
    }
  }

  // 3. River banks: small rocks just above the waterline, both sides, every ~5 m.
  const level = RIVER_WATER_DEPTH;
  for (let index = 6; index < RIVER_SAMPLES.length; index += Math.round(between(4, 7))) {
    const sample = RIVER_SAMPLES[index]!;
    const shore = lateralAtLevel(sample.bed + level, sample.bed, sample.bedHalfWidth, sample.rimHalfWidth, sample.rimHeight);
    for (const side of [-1, 1]) {
      if (random() < 0.25) continue;
      const scale = between(0.45, 0.95);
      const lateral = side * (shore + 0.4 + between(0, 1.1) + ROCK_RADIUS * scale * 0.4);
      add(ROCK, 'rock', sample.x + sample.dirZ * lateral, sample.z - sample.dirX * lateral, scale, true);
    }
  }

  // 4. The waterfall: rocks framing the sheet and the plunge pool's cliff-side rim, ferns on its shore.
  for (let step = 0; step < 14; step++) {
    const angle = (95 + step * 12.5) * (Math.PI / 180);
    const reach = 1.22 + 0.12 * random();
    const scale = between(0.9, 1.7);
    add(ROCK, 'rock', PLUNGE_POOL.x + Math.cos(angle) * PLUNGE_POOL.radiusX * reach, PLUNGE_POOL.z + Math.sin(angle) * PLUNGE_POOL.radiusZ * reach, scale, true);
  }
  for (let step = 0; step < 9; step++) {
    const angle = (-80 + step * 22) * (Math.PI / 180);
    const scale = between(0.8, 1.3);
    add(FERN, 'fern', PLUNGE_POOL.x + Math.cos(angle) * PLUNGE_POOL.radiusX * 1.3, PLUNGE_POOL.z + Math.sin(angle) * PLUNGE_POOL.radiusZ * 1.3, scale, true);
  }

  // 5. The flooded courtyard pools: ferns round the rims and a stone or two.
  for (const pool of COURTYARD_POOLS) {
    for (let step = 0; step < 6; step++) {
      const angle = (step / 6) * Math.PI * 2 + between(-0.3, 0.3);
      const scale = between(0.7, 1.1);
      const kind = step % 3 === 2;
      add(kind ? ROCK : FERN, kind ? 'rock' : 'fern', pool.x + Math.cos(angle) * pool.radiusX * 1.5, pool.z + Math.sin(angle) * pool.radiusZ * 1.5, kind ? scale * 0.6 : scale, true);
    }
  }

  // 6. Giant trees behind edges that face away from the camera: an outer ring on level ground.
  edgePolygons.forEach((polygon) => {
    const { points } = polygon;
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const direction = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
      const normal = { x: direction.z, z: -direction.x };
      if (normal.x * 0.5812 + normal.z * 0.8137 >= 0) continue;
      for (let distance = between(0.5, 4); distance < length - 0.2; distance += between(7, 11)) {
        const scale = between(0.55, 0.85);
        const radius = TREE_RADIUS * scale;
        for (let attempt = 0; attempt < 3; attempt++) {
          const offset = CANOPY_BOUNDARY_CLEARANCE + radius + 2.5 + between(0, 5) + attempt * 3;
          const x = a.x + direction.x * distance + normal.x * offset;
          const z = a.z + direction.z * distance + normal.z * offset;
          if (outwardCameraDot(edgePolygons, x, z) > TREE_CAMERA_DOT || !levelGround(x, z, radius)) continue;
          if (add(TREE, 'tree', x, z, scale)) break;
        }
      }
    }
  });

  // 7. Jungle fill: giant trees on a jittered grid across level ground behind the route (never camera-facing), then fern clumps
  // between everything within reach of the route, so no bare ground shows past the dressing along the edges.
  const extent = { minX: -90, maxX: 72, minZ: -66, maxZ: 22 };
  for (let z = extent.minZ; z < extent.maxZ; z += FILL_TREE_CELL) {
    for (let x = extent.minX; x < extent.maxX; x += FILL_TREE_CELL) {
      const tx = x + between(0, FILL_TREE_CELL);
      const tz = z + between(0, FILL_TREE_CELL);
      const scale = between(0.55, 0.9);
      if (random() < 0.25 || outwardCameraDot(edgePolygons, tx, tz) > TREE_CAMERA_DOT || !levelGround(tx, tz, TREE_RADIUS * scale)) continue;
      add(TREE, 'tree', tx, tz, scale);
    }
  }
  for (let z = extent.minZ; z < extent.maxZ; z += FILL_FERN_CELL) {
    for (let x = extent.minX; x < extent.maxX; x += FILL_FERN_CELL) {
      const fx = x + between(0, FILL_FERN_CELL);
      const fz = z + between(0, FILL_FERN_CELL);
      const scale = between(0.8, 1.3);
      if (random() < 0.45) continue;
      add(FERN, 'fern', fx, fz, scale);
    }
  }
  return placements;
}

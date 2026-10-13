import type { RegionDefinition, Vec3, WorldAssetPlacement } from '../game/contracts.js';
import { MISTVEIL_BOUNDARY_ID_PREFIX } from '../game/combat/MistveilContent.js';
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
import { channelReach, MIRE_POOLS, MISTVEIL_EXTENT, RIVER_SAMPLES, RIVER_WATER_DEPTH, SOURCE_POOL, waterMargin } from './MistveilWater.js';

export { MISTVEIL_BOUNDARY_ID_PREFIX };
/** Bank-rock placements: ids `mistveil-boundary-rock-<n>`; they stand on the lowest ground under their footprint. */
export const MISTVEIL_BOUNDARY_ROCK_ID_PREFIX = MISTVEIL_BOUNDARY_ID_PREFIX + 'rock-';
/** Minimum clear distance between any boundary footprint circle and a walkable surface (the contract asks >= 0.6 m). */
export const MISTVEIL_BOUNDARY_CLEARANCE = 0.8;
/** Radius around the stage goal ring (2.2 m) that stays free of boundary props. */
export const MISTVEIL_EXIT_CLEAR_RADIUS = 4.5;
/** Great root trees stay this far (centre to exit) from the goal, so the cavern mouth reads as a clearing. */
export const MISTVEIL_EXIT_TREE_CLEARING = 14;

const TREE = 'prop-mistveil-root-tree';
const ROCK = 'prop-mire-bank-rock';
const REED = 'prop-mistveil-reed-cluster';
/** The prop assets boundary dressing may use (with the rig, filter drum and cavern mouth, the whole prop set of the region). */
export const MISTVEIL_BOUNDARY_ASSET_IDS: readonly string[] = [TREE, ROCK, REED];

// Conservative plan-view radii (m) at placement scale 1: a 14 m root tree with buttress roots, a ~4 m bank rock and a ~2.4 m reed clump.
const TREE_RADIUS = 4;
const ROCK_RADIUS = 2;
const REED_RADIUS = 1.2;
/** Dressing further than this from every route anchor is never visible during play and is skipped. */
const ROUTE_VISIBILITY_RANGE = 25;
/** Root trees (14 m tall) show above the horizon of the fixed camera from much farther away. */
const TREE_VISIBILITY_RANGE = 40;
/** Edges whose outward normal faces the camera more than this receive only low props (reeds, small rocks). */
const CAMERA_FACING = 0.15;
/** Camera-facing rule applies within this distance of the walk-mesh; reeds there keep >= 4 m away and stay <= 0.6 scale. */
const CAMERA_FACING_RANGE = 14;
const CAMERA_FACING_REED_DISTANCE = 4;
const CAMERA_FACING_REED_SCALE = 0.6;
/** Channels: anything standing on level ground stays this many rim half widths from the river or a pool; trees also keep dry. */
const CHANNEL_REACH_LIMIT = 1.3;
const TREE_WATER_MARGIN = 3;
const SEED = 0x4d15714;
/** Grid cells (m) of the wetland fill. */
const FILL_TREE_CELL = 9;
const FILL_REED_CELL = 3.6;

interface Polygon { readonly points: readonly Point[] }

/** Plan-view circle that conservatively covers a placement's visible volume. */
export function mistveilFootprint(assetId: string, position: Readonly<Vec3>, scale: Readonly<Vec3>): FootprintCircle {
  const unit = assetId === TREE ? TREE_RADIUS : assetId === ROCK ? ROCK_RADIUS : REED_RADIUS;
  return { x: position.x, z: position.z, radius: unit * Math.max(scale.x, scale.z) };
}

/**
 * Deterministic dressing that frames the sealed route so it reads as drowned wetland: reed clumps and bank rocks along every
 * walkable edge, rocks and reeds along the Black Sap river and round the pools, and great root trees behind the edges that
 * face away from the gameplay camera (never on the camera-facing ones, so Aren stays visible). Every footprint circle stays
 * >= {@link MISTVEIL_BOUNDARY_CLEARANCE} from every walkable surface, off the water, clear of gate boxes, arenas, the goal ring
 * and authored set dressing. Placements add no simulation colliders.
 */
export function buildMistveilBoundaryPlacements(region: RegionDefinition, keepClear: BoundaryKeepClear = { gates: [], arenas: [] }): WorldAssetPlacement[] {
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
  const counters = { tree: 0, rock: 0, reed: 0 };

  /** Everything every kind must respect; `bank` placements deliberately stand beside the water. */
  const clear = (circle: FootprintCircle, bank: boolean, range: number): boolean => {
    for (const polygon of walkable) if (distanceToPolygon(polygon.points, circle.x, circle.z) < circle.radius + MISTVEIL_BOUNDARY_CLEARANCE) return false;
    for (const gate of keepClear.gates) if (distanceToBoxFootprint(gate, circle.x, circle.z) < circle.radius + 0.5) return false;
    for (const arena of keepClear.arenas) if (Math.hypot(circle.x - arena.center.x, circle.z - arena.center.z) < arena.radius + circle.radius + 0.5) return false;
    if (exit && Math.hypot(circle.x - exit.x, circle.z - exit.z) < (circle.radius > 2.5 ? MISTVEIL_EXIT_TREE_CLEARING : MISTVEIL_EXIT_CLEAR_RADIUS + circle.radius)) return false;
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

  const add = (assetId: string, kind: 'tree' | 'rock' | 'reed', x: number, z: number, requestedScale: number, bank = false): boolean => {
    let scale = requestedScale;
    // Edges whose outward normal faces the camera (same rule as Greenwake and the canopy): no rocks or trees at all, and only
    // small reeds (scale <= 0.6) at least 4 m from the walk-mesh, so nothing big and dark fills the lower-right of the screen.
    if (outwardCameraDot(walkable, x, z) > CAMERA_FACING && distanceToWalkable(x, z) < CAMERA_FACING_RANGE) {
      if (kind !== 'reed' || distanceToWalkable(x, z) < CAMERA_FACING_REED_DISTANCE) return false;
      scale = Math.min(scale, CAMERA_FACING_REED_SCALE);
    }
    const position = { x, y: 0, z };
    const scales = { x: scale, y: scale * (kind === 'reed' ? between(0.9, 1.3) : kind === 'rock' ? between(0.8, 1.15) : 1), z: scale };
    const circle = mistveilFootprint(assetId, position, scales);
    if (!clear(circle, bank, kind === 'tree' ? TREE_VISIBILITY_RANGE : ROUTE_VISIBILITY_RANGE)) return false;
    placed.push(circle);
    placements.push({ id: `${MISTVEIL_BOUNDARY_ID_PREFIX}${kind}-${counters[kind]++}`, assetId, position, rotationY: random() * Math.PI * 2, scale: scales, placement: 'ground' });
    return true;
  };

  /** Level, dry ground for a root-tree trunk: well clear of every pool and the river's banks. */
  const levelGround = (x: number, z: number, radius: number): boolean => waterMargin(x, z) >= TREE_WATER_MARGIN + radius;

  // 1. Low dressing along every walkable edge: reed clumps and (behind the route) bank rocks.
  for (const polygon of walkable) {
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
      for (let distance = between(0.4, 2.2); distance < length - 0.2; distance += between(2.4, 4.2)) {
        const base = { x: a.x + direction.x * distance, z: a.z + direction.z * distance };
        const wantRock = random() < (facing ? 0.2 : 0.4);
        for (let attempt = 0; attempt < 2; attempt++) {
          const scale = wantRock ? (facing ? between(0.45, 0.7) : between(0.8, 1.35)) : between(0.75, 1.3);
          const radius = (wantRock ? ROCK_RADIUS : REED_RADIUS) * scale;
          const offset = MISTVEIL_BOUNDARY_CLEARANCE + radius + 0.1 + between(0, 0.9) + attempt * 0.9;
          if (add(wantRock ? ROCK : REED, wantRock ? 'rock' : 'reed', base.x + normal.x * offset, base.z + normal.z * offset, scale)) break;
        }
      }
    }
  }

  // 2. River banks: small rocks and reed clumps just above the waterline, both sides, every ~5 m.
  for (let index = 6; index < RIVER_SAMPLES.length; index += Math.round(between(3, 6))) {
    const sample = RIVER_SAMPLES[index]!;
    const shore = lateralAtLevel(sample.bed + RIVER_WATER_DEPTH, sample.bed, sample.bedHalfWidth, sample.rimHalfWidth, sample.rimHeight);
    for (const side of [-1, 1]) {
      if (random() < 0.2) continue;
      const rock = random() < 0.45;
      const scale = rock ? between(0.45, 0.95) : between(0.8, 1.3);
      const lateral = side * (shore + 0.4 + between(0, 1.1) + (rock ? ROCK_RADIUS : REED_RADIUS) * scale * 0.4);
      add(rock ? ROCK : REED, rock ? 'rock' : 'reed', sample.x + sample.dirZ * lateral, sample.z - sample.dirX * lateral, scale, true);
    }
  }

  // 3. The pools: reeds round every rim and a stone or two; the source seep gets a ring of rocks.
  for (const pool of MIRE_POOLS) {
    for (let step = 0; step < 6; step++) {
      const angle = (step / 6) * Math.PI * 2 + between(-0.3, 0.3);
      const scale = between(0.7, 1.1);
      const stone = step % 3 === 2;
      add(stone ? ROCK : REED, stone ? 'rock' : 'reed', pool.x + Math.cos(angle) * pool.radiusX * 1.5, pool.z + Math.sin(angle) * pool.radiusZ * 1.5, stone ? scale * 0.6 : scale, true);
    }
  }
  for (let step = 0; step < 12; step++) {
    const angle = (step / 12) * Math.PI * 2 + between(-0.15, 0.15);
    add(step % 2 === 0 ? ROCK : REED, step % 2 === 0 ? 'rock' : 'reed', SOURCE_POOL.x + Math.cos(angle) * SOURCE_POOL.radiusX * 1.4, SOURCE_POOL.z + Math.sin(angle) * SOURCE_POOL.radiusZ * 1.4, between(0.7, 1.2), true);
  }

  // 4. Root trees behind edges that face away from the camera: an outer ring on dry ground.
  for (const polygon of walkable) {
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
          const offset = MISTVEIL_BOUNDARY_CLEARANCE + radius + 2.5 + between(0, 5) + attempt * 3;
          const x = a.x + direction.x * distance + normal.x * offset;
          const z = a.z + direction.z * distance + normal.z * offset;
          if (outwardCameraDot(walkable, x, z) > TREE_CAMERA_DOT || !levelGround(x, z, radius)) continue;
          if (add(TREE, 'tree', x, z, scale)) break;
        }
      }
    }
  }

  // 5. Wetland fill: root trees on a jittered grid across dry ground behind the route (never camera-facing), then reed clumps
  // between everything within reach of the route, so no bare ground shows past the dressing along the edges.
  const extent = MISTVEIL_EXTENT;
  for (let z = extent.minZ; z < extent.maxZ; z += FILL_TREE_CELL) {
    for (let x = extent.minX; x < extent.maxX; x += FILL_TREE_CELL) {
      const tx = x + between(0, FILL_TREE_CELL);
      const tz = z + between(0, FILL_TREE_CELL);
      const scale = between(0.55, 0.9);
      if (random() < 0.3 || outwardCameraDot(walkable, tx, tz) > TREE_CAMERA_DOT || !levelGround(tx, tz, TREE_RADIUS * scale)) continue;
      add(TREE, 'tree', tx, tz, scale);
    }
  }
  for (let z = extent.minZ; z < extent.maxZ; z += FILL_REED_CELL) {
    for (let x = extent.minX; x < extent.maxX; x += FILL_REED_CELL) {
      const rx = x + between(0, FILL_REED_CELL);
      const rz = z + between(0, FILL_REED_CELL);
      const scale = between(0.8, 1.3);
      if (random() < 0.4) continue;
      add(REED, 'reed', rx, rz, scale);
    }
  }
  return placements;
}

import type { RegionDefinition, Vec3, WorldAssetPlacement } from '../game/contracts.js';
import {
  distanceToBoxFootprint, distanceToPolygon, distanceToSegment, outwardCameraDot, TREE_CAMERA_DOT, type BoundaryKeepClear, type FootprintCircle, type Point,
} from './GreenwakeBoundary.js';
import { mulberry32 } from './GroundNoise.js';

/** Boundary placements are visual only; solid-props.ts classifies this id prefix as 'decoration' (no colliders). */
export const BAMBOO_BOUNDARY_ID_PREFIX = 'bamboo-boundary-';
/** Cliff-rock placements: ids `bamboo-boundary-rock-<n>`; they stand on the lowest ground under their footprint. */
export const BAMBOO_BOUNDARY_ROCK_ID_PREFIX = BAMBOO_BOUNDARY_ID_PREFIX + 'rock-';
/** Minimum clear distance between any boundary footprint circle and a walkable surface. */
export const BAMBOO_BOUNDARY_CLEARANCE = 0.8;
/** Radius around the valley exit (the Grove route) that stays free of boundary props. */
export const BAMBOO_EXIT_CLEAR_RADIUS = 4.5;
/** Tall bamboo never stands closer than this to the exit, so the way home reads as a clearing. */
export const BAMBOO_EXIT_TREE_CLEARING = 12;

const CLUSTER = 'prop-bamboo-grove-cluster';
const ROCK = 'prop-canopy-cliff-rock';
const FERN = 'prop-canopy-fern-cluster';
/** The prop assets boundary dressing may use (all in the Bamboo candidate catalog). */
export const BAMBOO_BOUNDARY_ASSET_IDS: readonly string[] = [CLUSTER, ROCK, FERN];

// Conservative plan-view radii (m) at placement scale 1: the cluster is a 9 m tall stand of stems, the rock a ~3.6 m outcrop, the fern a ~2.4 m clump.
const CLUSTER_RADIUS = 4;
const ROCK_RADIUS = 1.8;
const FERN_RADIUS = 1.2;
/** Dressing further than this from every route anchor is never visible during play and is skipped. */
const ROUTE_VISIBILITY_RANGE = 24;
/** Spacing along an edge (m) between tall stands, and between low props on edges that face the camera. */
const TALL_SPACING = [7, 10] as const;
const LOW_SPACING = [3.5, 5.5] as const;
const SEED = 0xba3b00;

interface Polygon { readonly points: readonly Point[] }

/** Plan-view circle that conservatively covers a placement's visible volume. */
export function bambooFootprint(assetId: string, position: Readonly<Vec3>, scale: Readonly<Vec3>): FootprintCircle {
  const unit = assetId === CLUSTER ? CLUSTER_RADIUS : assetId === ROCK ? ROCK_RADIUS : FERN_RADIUS;
  return { x: position.x, z: position.z, radius: unit * Math.max(scale.x, scale.z) };
}

/**
 * Deterministic dressing that frames the valley's walk-mesh: tall bamboo stands behind every edge that faces away from the
 * gameplay camera (never in front, so Aren and the boss stay visible), low ferns and cliff rocks along the camera-facing edges
 * so sight lines across the camp and the den stay broad and clear. Every footprint circle stays at least
 * {@link BAMBOO_BOUNDARY_CLEARANCE} from every walkable surface, clear of authored set dressing, the arenas and the exit, and
 * never overlaps another boundary prop. Placements add no simulation colliders.
 */
export function buildBambooBoundaryPlacements(region: RegionDefinition, keepClear: BoundaryKeepClear = { gates: [], arenas: [] }): WorldAssetPlacement[] {
  const polygons: Polygon[] = region.ground.surfaces.filter((surface) => surface.walkable).map((surface) => ({ points: surface.points.map((point) => ({ x: point.x, z: point.z })) }));
  const exit = region.exits.find((route) => route.id === 'bamboo-grove-out')?.from;
  const routeSegments: [Point, Point][] = [];
  for (const ribbon of region.navigation.ribbons) for (let index = 1; index < ribbon.points.length; index++) routeSegments.push([ribbon.points[index - 1]!, ribbon.points[index]!]);
  const nearRoute = (x: number, z: number): boolean => routeSegments.some(([a, b]) => distanceToSegment(x, z, a, b) <= ROUTE_VISIBILITY_RANGE);
  const random = mulberry32(SEED);
  const placed: FootprintCircle[] = [];
  const placements: WorldAssetPlacement[] = [];
  let rocks = 0;

  const clear = (circle: FootprintCircle): boolean => {
    for (const polygon of polygons) if (distanceToPolygon(polygon.points, circle.x, circle.z) < circle.radius + BAMBOO_BOUNDARY_CLEARANCE) return false;
    for (const gate of keepClear.gates) if (distanceToBoxFootprint(gate, circle.x, circle.z) < circle.radius + 0.5) return false;
    for (const arena of keepClear.arenas) if (Math.hypot(circle.x - arena.center.x, circle.z - arena.center.z) < arena.radius + circle.radius + 0.5) return false;
    if (exit && Math.hypot(circle.x - exit.x, circle.z - exit.z) < (circle.radius > 2.5 ? BAMBOO_EXIT_TREE_CLEARING : BAMBOO_EXIT_CLEAR_RADIUS + circle.radius)) return false;
    for (const obstacle of keepClear.obstacles ?? []) if (Math.hypot(circle.x - obstacle.x, circle.z - obstacle.z) < 0.6 * (obstacle.radius + circle.radius)) return false;
    for (const other of placed) if (Math.hypot(circle.x - other.x, circle.z - other.z) < 0.6 * (circle.radius + other.radius)) return false;
    return nearRoute(circle.x, circle.z);
  };
  const place = (assetId: string, position: Vec3, rotationY: number, scale: number, id: string): void => {
    const circle = bambooFootprint(assetId, position, { x: scale, y: scale, z: scale });
    if (!clear(circle)) return;
    placed.push(circle);
    placements.push({ id, assetId, position, rotationY, scale: { x: scale, y: scale, z: scale }, placement: 'ground' });
  };

  for (const polygon of polygons) {
    const { points } = polygon;
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!, b = points[(index + 1) % points.length]!;
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (length < 1e-6) continue;
      const tx = dx / length, tz = dz / length;
      for (const side of [1, -1]) {
        // Candidate edge normal pointing away from this polygon.
        const nx = -tz * side, nz = tx * side;
        const probe = { x: (a.x + b.x) / 2 + nx * 0.5, z: (a.z + b.z) / 2 + nz * 0.5 };
        if (insideAny(polygons, probe.x, probe.z)) continue;
        let along = random() * 3;
        while (along < length) {
          const baseX = a.x + tx * along, baseZ = a.z + tz * along;
          const facing = outwardCameraDot(polygons, baseX + nx * 2, baseZ + nz * 2);
          const tall = facing <= TREE_CAMERA_DOT;
          const [min, max] = tall ? TALL_SPACING : LOW_SPACING;
          const assetId = tall ? CLUSTER : random() < 0.45 ? ROCK : FERN;
          const scale = tall ? 0.7 + random() * 0.35 : assetId === ROCK ? 0.6 + random() * 0.5 : 0.7 + random() * 0.4;
          const radius = bambooFootprint(assetId, { x: 0, y: 0, z: 0 }, { x: scale, y: scale, z: scale }).radius;
          const offset = BAMBOO_BOUNDARY_CLEARANCE + radius + 0.3 + random() * (tall ? 3 : 1.2);
          const position = { x: baseX + nx * offset, y: 0, z: baseZ + nz * offset };
          const id = assetId === ROCK ? BAMBOO_BOUNDARY_ROCK_ID_PREFIX + rocks : BAMBOO_BOUNDARY_ID_PREFIX + (tall ? 'stand-' : 'fern-') + placements.length;
          const before = placements.length;
          place(assetId, position, random() * Math.PI * 2, scale, id);
          if (assetId === ROCK && placements.length > before) rocks++;
          along += min + random() * (max - min);
        }
      }
    }
  }
  return placements;
}

function pointInPolygon(points: readonly Point[], x: number, z: number): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index]!, b = points[previous]!;
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
function insideAny(polygons: readonly Polygon[], x: number, z: number): boolean {
  return polygons.some((polygon) => pointInPolygon(polygon.points, x, z));
}

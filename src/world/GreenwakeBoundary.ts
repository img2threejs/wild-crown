import type { RegionColliderDefinition, RegionDefinition, Vec3, WorldAssetPlacement } from '../game/contracts.js';
import { CREEK_Z_END, CREEK_Z_START, creekSection } from './GreenwakeCreekShape.js';
import { mulberry32 } from './GroundNoise.js';
import { isBridgeDeckSurface, isRaisedWalkSurface } from './WalkSurfaces.js';

/** Boundary placements are visual only; solid-props.ts classifies this id prefix as 'decoration'. */
export const GREENWAKE_BOUNDARY_ID_PREFIX = 'greenwake-boundary-';
/** Rock outcrops on embankment faces and creek banks; same decoration-only contract, ids `greenwake-boundary-rock-<n>`. */
export const GREENWAKE_BOUNDARY_ROCK_ID_PREFIX = GREENWAKE_BOUNDARY_ID_PREFIX + 'rock-';
/** Minimum clear distance between any boundary footprint circle and the walk-mesh. */
export const GREENWAKE_BOUNDARY_CLEARANCE = 0.8;
/** Radius around the Forest Exit goal ring (2.2 m) that stays free of boundary props. */
export const GREENWAKE_EXIT_CLEAR_RADIUS = 4.5;

export interface FootprintCircle { readonly x: number; readonly z: number; readonly radius: number }
export interface BoundaryKeepClear {
  /** Closed trial gate boxes (xz footprint is kept clear). */
  readonly gates: readonly RegionColliderDefinition[];
  /** Dodge arenas; boundary props never enter these circles. */
  readonly arenas: readonly { readonly center: Readonly<Vec3>; readonly radius: number }[];
  /** Authored set-dressing that stays in place (houses, cages, arches, collider-paired trees). */
  readonly obstacles?: readonly FootprintCircle[];
}

// Conservative plan-view footprints, per unit placement scale.
// Tree: the 6 m-scaled Erya tree measures +-2.45 x +-2.94 m at the base and 3.22 m radius overall.
const TREE_RADIUS = 3.25;
// Assumed Tripo prop sizes at placement scale 1 (the manifest transform must normalise to these):
// bramble wall: ~3.2 m long (local +x) x ~1.6 m deep x ~1.5 m tall; boulder cluster: ~3 m wide x ~1.5 m tall.
const BRAMBLE_HALF_LENGTH = 1.6;
const BRAMBLE_CIRCLE_RADIUS = 0.8;
const BOULDER_RADIUS = 1.5;
/** Yaw added to the edge direction so the bramble wall's long axis follows the path edge. */
const BRAMBLE_YAW_OFFSET = 0;
const INNER_RING_DEPTH = 1.8;
/** Horizontal camera direction (offset +10, +14 from the player). Edges facing it only receive low props. */
const CAMERA_X = 10 / Math.hypot(10, 14), CAMERA_Z = 14 / Math.hypot(10, 14);
/** Trees further than the edge test: a tree whose nearest route edge faces the camera more than this is dropped. */
export const TREE_CAMERA_DOT = 0.1;
/** Inner ring spacing along an edge (m); bramble pieces are stretched along the edge instead of adding instances. */
const INNER_SPACING = [4, 5.5] as const;
const OUTER_SPACING = [6, 9] as const;
/** An inner prop is skipped where a surviving authored tree's canopy (or authored landmark) is this close to the edge point. */
const FRAMED_BY_AUTHORED = 2;
/** An outer-ring tree is skipped when an authored tree stands this close. */
const TREE_NEIGHBOUR_CLEARANCE = 4;
/** Dressing further than this from every route anchor is never visible during play and is skipped. */
const ROUTE_VISIBILITY_RANGE = 25;
const SEED = 0x57a1d0;
/** Share of inner-ring slots that receive a stretched bramble wall (the rest are boulder clusters). */
const BRAMBLE_SHARE = 0.5;

const BRAMBLE = 'prop-greenwake-bramble-wall', BOULDER = 'prop-greenwake-boulder-cluster', TREE = 'prop-erya-edge-tree';
/** Authored landmark footprints (radius per unit scale) measured from the native GLBs: houses 1.4 x 2.9 m, cage 1.2 x 0.95 m, root arch 0.8 x 2 m. */
const AUTHORED_RADIUS: Readonly<Record<string, number>> = { 'prop-greenwake-houses': 3.3, 'prop-hunter-cage': 1.6, 'prop-root-arch': 2.1 };

export interface Point { x: number; z: number }
interface Polygon { readonly points: readonly Point[]; readonly elevated: boolean }
interface Accepted { readonly circles: readonly FootprintCircle[]; readonly edge: number }

/** Plan-view circles that conservatively cover a placement's visible volume. */
export function greenwakeFootprint(assetId: string, position: Readonly<Vec3>, rotationY: number, scale: Readonly<Vec3>): FootprintCircle[] {
  const s = Math.max(scale.x, scale.z);
  if (assetId === BRAMBLE) {
    // Long axis scales independently (scale.x); depth and height follow scale.z. Circles overlap along the whole stretched
    // piece and keep the original +-1.2 m reach at unit scale (0.4 m beyond the assumed 3.2 m body).
    const radius = BRAMBLE_CIRCLE_RADIUS * scale.z;
    const reach = BRAMBLE_HALF_LENGTH * scale.x - 0.5 * radius;
    const count = Math.max(4, Math.ceil(2 * reach / radius) + 1);
    const ax = Math.cos(rotationY - BRAMBLE_YAW_OFFSET), az = -Math.sin(rotationY - BRAMBLE_YAW_OFFSET);
    return Array.from({ length: count }, (_, index) => {
      const offset = -reach + index * 2 * reach / (count - 1);
      return { x: position.x + ax * offset, z: position.z + az * offset, radius };
    });
  }
  return [{ x: position.x, z: position.z, radius: (assetId === TREE ? TREE_RADIUS : assetId === BOULDER ? BOULDER_RADIUS : AUTHORED_RADIUS[assetId] ?? 1) * s }];
}

export function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) { const a = points[i]!, b = points[(i + 1) % points.length]!; sum += a.x * b.z - b.x * a.z; }
  return sum / 2;
}
export function insidePolygon(points: readonly Point[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
export function distanceToSegment(x: number, z: number, a: Point, b: Point): number {
  const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}
export function distanceToPolygon(points: readonly Point[], x: number, z: number): number {
  if (insidePolygon(points, x, z)) return 0;
  let best = Infinity;
  for (let i = 0; i < points.length; i++) best = Math.min(best, distanceToSegment(x, z, points[i]!, points[(i + 1) % points.length]!));
  return best;
}
/** Distance from a point to the xz footprint of an axis-aligned box collider (0 inside). */
export function distanceToBoxFootprint(box: RegionColliderDefinition, x: number, z: number): number {
  const half = box.halfExtents!;
  const dx = Math.max(Math.abs(x - box.from.x) - half.x, 0), dz = Math.max(Math.abs(z - box.from.z) - half.z, 0);
  return Math.hypot(dx, dz);
}

/** Shortest xz distance from a point to any walkable surface of the region (0 on the mesh). */
export function distanceToWalkMesh(region: RegionDefinition, x: number, z: number): number {
  let best = Infinity;
  for (const surface of region.ground.surfaces) if (surface.walkable) best = Math.min(best, distanceToPolygon(surface.points, x, z));
  return best;
}

/**
 * Camera-side score of a point: the outward direction (nearest walkable edge point -> point) dotted with the horizontal
 * camera direction. Positive values sit between the route and the camera.
 */
export function outwardCameraDot(polygons: readonly { readonly points: readonly Point[] }[], x: number, z: number): number {
  let best = Infinity, nx = 0, nz = 0;
  for (const polygon of polygons) {
    const { points } = polygon;
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!, b = points[(index + 1) % points.length]!;
      const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
      const px = a.x + dx * t, pz = a.z + dz * t, distance = Math.hypot(x - px, z - pz);
      if (distance < best && distance > 1e-9) { best = distance; nx = (x - px) / distance; nz = (z - pz) / distance; }
    }
  }
  return nx * CAMERA_X + nz * CAMERA_Z;
}

/**
 * Deterministic dressing that frames the outer edge of the y=0 walk-mesh. Inner ring: low bramble walls and boulder
 * clusters; outer ring: small Erya trees behind them, omitted on edges facing the gameplay camera so the player stays
 * visible. Every footprint circle stays >= 0.8 m clear of every walkable surface (elevated ones included), gate boxes,
 * arenas and the Forest Exit goal. Placements add no simulation colliders.
 */
export function buildGreenwakeBoundaryPlacements(
  region: RegionDefinition, keepClear: BoundaryKeepClear = { gates: [], arenas: [] },
): WorldAssetPlacement[] {
  const polygons: Polygon[] = [];
  for (const surface of region.ground.surfaces) {
    if (!surface.walkable) continue;
    const points = surface.points.map(point => ({ x: point.x, z: point.z }));
    if (polygonArea(points) < 0) points.reverse();
    polygons.push({ points, elevated: surface.elevation !== 0 || surface.points.some(point => point.y !== 0) });
  }
  const exit = region.exits.find(route => route.id === 'greenwake-grove-out')?.from;
  const random = mulberry32(SEED);
  const between = (min: number, max: number) => min + (max - min) * random();

  const clear = (circles: readonly FootprintCircle[]): boolean => {
    for (const circle of circles) {
      for (const polygon of polygons) if (distanceToPolygon(polygon.points, circle.x, circle.z) < circle.radius + GREENWAKE_BOUNDARY_CLEARANCE) return false;
      for (const gate of keepClear.gates) if (distanceToBoxFootprint(gate, circle.x, circle.z) < circle.radius + 0.5) return false;
      for (const arena of keepClear.arenas) if (Math.hypot(circle.x - arena.center.x, circle.z - arena.center.z) < arena.radius + circle.radius + 0.5) return false;
      if (exit && Math.hypot(circle.x - exit.x, circle.z - exit.z) < GREENWAKE_EXIT_CLEAR_RADIUS + circle.radius) return false;
      for (const obstacle of keepClear.obstacles ?? []) if (Math.hypot(circle.x - obstacle.x, circle.z - obstacle.z) < 0.6 * (obstacle.radius + circle.radius)) return false;
    }
    return true;
  };
  const crossesWalkMesh = (from: Point, normal: Point, depth: number): boolean => {
    for (let t = 0.3; t < depth; t += 0.7) {
      const x = from.x + normal.x * t, z = from.z + normal.z * t;
      for (const polygon of polygons) if (insidePolygon(polygon.points, x, z)) return true;
    }
    return false;
  };

  const placements: WorldAssetPlacement[] = [];
  const innerRing: Accepted[] = [], outerRing: Accepted[] = [];
  let edgeSerial = 0;
  // Authored trees that stay in the playtest layout (their canopy never reaches the path) and authored landmarks.
  const survivingTrees: FootprintCircle[] = [];
  for (const prop of region.props) {
    if (prop.assetId !== TREE) continue;
    const [circle] = greenwakeFootprint(prop.assetId, prop.position, prop.rotationY, prop.scale);
    if (distanceToWalkMesh(region, circle!.x, circle!.z) >= circle!.radius + 0.5) survivingTrees.push(circle!);
  }
  const framing = [...survivingTrees, ...(keepClear.obstacles ?? [])];
  const routeSegments: [Point, Point][] = [];
  for (const ribbon of region.navigation.ribbons) {
    for (let index = 1; index < ribbon.points.length; index++) routeSegments.push([ribbon.points[index - 1]!, ribbon.points[index]!]);
  }
  if (exit) routeSegments.push([exit, exit]);
  const visibleFromRoute = (point: Point) => routeSegments.some(([a, b]) => distanceToSegment(point.x, point.z, a, b) <= ROUTE_VISIBILITY_RANGE);
  const tryPlace = (ring: Accepted[], kind: 'inner' | 'outer', edge: number, name: string, base: Point, normal: Point, direction: Point | undefined): void => {
    const jitter = random();
    const choice = random();
    let assetId: string, sx: number, sz: number, offset: number, rotationY: number;
    if (kind === 'outer') {
      assetId = TREE; sx = sz = 0.5 + 0.3 * jitter;
      offset = GREENWAKE_BOUNDARY_CLEARANCE + TREE_RADIUS * sz + INNER_RING_DEPTH + jitter * 0.6;
      rotationY = choice * Math.PI * 2;
    } else if (direction && choice < BRAMBLE_SHARE) {
      // One long piece stretched along the edge (4.6-5.6 m) instead of several instances.
      assetId = BRAMBLE; sz = 0.9 + 0.2 * jitter; sx = sz * (1.5 + 0.35 * jitter);
      offset = GREENWAKE_BOUNDARY_CLEARANCE + BRAMBLE_CIRCLE_RADIUS * sz + 0.05 + jitter * 0.5;
      rotationY = Math.atan2(-direction.z, direction.x) + BRAMBLE_YAW_OFFSET + (random() - 0.5) * 0.12;
    } else {
      assetId = BOULDER; sx = sz = 0.9 + 0.3 * jitter;
      offset = GREENWAKE_BOUNDARY_CLEARANCE + BOULDER_RADIUS * sz + 0.05 + jitter * 0.5;
      rotationY = choice * Math.PI * 2;
    }
    if (!visibleFromRoute(base)) return;
    if (kind === 'inner' && framing.some(frame => Math.hypot(base.x - frame.x, base.z - frame.z) - frame.radius <= FRAMED_BY_AUTHORED)) return;
    const position = { x: base.x + normal.x * offset, y: 0, z: base.z + normal.z * offset };
    if (kind === 'outer' && survivingTrees.some(tree => Math.hypot(position.x - tree.x, position.z - tree.z) < TREE_NEIGHBOUR_CLEARANCE)) return;
    const scale = { x: sx, y: sz, z: sz };
    const circles = greenwakeFootprint(assetId, position, rotationY, scale);
    if (!clear(circles) || crossesWalkMesh(base, normal, offset)) return;
    if (kind === 'outer' && outwardCameraDot(polygons, position.x, position.z) > TREE_CAMERA_DOT) return;
    for (const other of ring) {
      if (other.edge === edge) continue;
      for (const a of circles) for (const b of other.circles) if (Math.hypot(a.x - b.x, a.z - b.z) < 0.5 * (a.radius + b.radius)) return;
    }
    ring.push({ circles, edge });
    const id = GREENWAKE_BOUNDARY_ID_PREFIX + (kind === 'inner' ? 'low-' : 'tree-') + name;
    placements.push({ id, assetId, position, rotationY, scale, placement: 'ground' });
  };

  polygons.forEach((polygon, polygonIndex) => {
    if (polygon.elevated) return;
    const { points } = polygon;
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!, b = points[(index + 1) % points.length]!, before = points[(index + points.length - 1) % points.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const direction = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
      // The polygon is counter-clockwise in (x, z), so outward is to the right of travel.
      const normal = { x: direction.z, z: -direction.x };
      const cameraDot = normal.x * CAMERA_X + normal.z * CAMERA_Z;
      const edge = edgeSerial++;
      for (const kind of ['inner', 'outer'] as const) {
        // Trees only stand behind edges that face away from the camera; low props wrap every edge.
        if (kind === 'outer' && cameraDot >= 0) continue;
        const [spacingMin, spacingMax] = kind === 'inner' ? INNER_SPACING : OUTER_SPACING;
        let distance = between(0.5, spacingMin), serial = 0;
        while (distance < length - 0.2) {
          const base = { x: a.x + direction.x * distance, z: a.z + direction.z * distance };
          tryPlace(kind === 'inner' ? innerRing : outerRing, kind, edge, `${polygonIndex}-${index}-${serial++}`, base, normal, direction);
          distance += between(spacingMin, spacingMax);
        }
      }
      // Convex corners get one symmetric boulder/tree along the outward bisector so hedges stay continuous.
      const incoming = Math.hypot(a.x - before.x, a.z - before.z);
      if (incoming < 1e-6) continue;
      const previousDirection = { x: (a.x - before.x) / incoming, z: (a.z - before.z) / incoming };
      const turn = previousDirection.x * direction.z - previousDirection.z * direction.x;
      if (turn <= 0.05) continue;
      const bisector = { x: direction.z + previousDirection.z, z: -direction.x - previousDirection.x };
      const size = Math.hypot(bisector.x, bisector.z);
      if (size < 1e-6) continue;
      const corner = { x: bisector.x / size, z: bisector.z / size };
      const cornerDot = corner.x * CAMERA_X + corner.z * CAMERA_Z;
      tryPlace(innerRing, 'inner', edge, `${polygonIndex}-${index}-corner`, a, corner, undefined);
      if (cornerDot < 0) tryPlace(outerRing, 'outer', edge, `${polygonIndex}-${index}-corner`, a, corner, undefined);
    }
  });

  // Rock outcrops: partly sunk boulder clusters on the steep faces of the terrain-backed ramps / ridge and along the creek banks.
  // A separate random stream keeps every placement above unchanged; the same `clear` rules apply (decoration only, no colliders).
  const rockRandom = mulberry32(SEED + 1);
  const rockBetween = (min: number, max: number) => min + (max - min) * rockRandom();
  const occupied = [...innerRing, ...outerRing].flatMap(accepted => accepted.circles);
  let rockSerial = 0;
  const tryRock = (x: number, z: number, size: number): void => {
    const rotationY = rockRandom() * Math.PI * 2;
    const scale = { x: size * rockBetween(0.9, 1.3), y: size * rockBetween(0.7, 1.1), z: size * rockBetween(0.9, 1.3) };
    const position = { x, y: 0, z };
    const circles = greenwakeFootprint(BOULDER, position, rotationY, scale);
    if (!clear(circles) || !visibleFromRoute({ x, z })) return;
    // Never in or beside the water: the rock's whole footprint stays on the banks.
    const section = creekSection(z);
    if (z > CREEK_Z_START && z < CREEK_Z_END && Math.abs(x - section.centerX) < section.bedHalfWidth + 0.45 + circles[0]!.radius * 0.5) return;
    for (const circle of circles) for (const other of occupied) if (Math.hypot(circle.x - other.x, circle.z - other.z) < 0.8 * (circle.radius + other.radius)) return;
    occupied.push(...circles);
    placements.push({ id: GREENWAKE_BOUNDARY_ROCK_ID_PREFIX + rockSerial++, assetId: BOULDER, position, rotationY, scale, placement: 'ground' });
  };
  for (const surface of region.ground.surfaces) {
    if (!isRaisedWalkSurface(surface) || isBridgeDeckSurface(surface)) continue;
    const points = surface.points.map(point => ({ x: point.x, y: point.y, z: point.z }));
    if (polygonArea(points) < 0) points.reverse();
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!, b = points[(index + 1) % points.length]!;
      // Only faces that stand well above the ground need rocks.
      if (Math.max(a.y, b.y) < 0.9) continue;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const direction = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
      const normal = { x: direction.z, z: -direction.x };
      for (let distance = rockBetween(0.6, 1.6); distance < length - 0.4; distance += rockBetween(2.8, 4.4)) {
        // Two tries per slot (the second one a little further down the face) so slots beside other props still get a rock.
        for (let attempt = 0; attempt < 2; attempt++) {
          const size = rockBetween(0.38, 0.62);
          const offset = GREENWAKE_BOUNDARY_CLEARANCE + BOULDER_RADIUS * size + 0.1 + rockBetween(0, 0.9) + attempt * 0.8;
          const before = placements.length;
          tryRock(a.x + direction.x * distance + normal.x * offset, a.z + direction.z * distance + normal.z * offset, size);
          if (placements.length > before) break;
        }
      }
    }
  }
  for (let z = 11.5; z < 31; z += rockBetween(1.8, 3)) {
    const section = creekSection(z);
    for (const side of [-1, 1]) {
      const lateral = section.bedHalfWidth + rockBetween(0.5, 1.6);
      if (rockRandom() < 0.2) continue;
      tryRock(section.centerX + side * lateral, z, rockBetween(0.3, 0.5));
    }
  }
  return placements;
}

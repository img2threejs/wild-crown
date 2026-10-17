import type { Bounds3, GroundSurfaceDefinition, RegionColliderDefinition, RegionDefinition, RegionRouteDefinition, Vec3 } from '../contracts.js';
import type { CameraBasis } from './CombatEngine.js';
import type { TraversalAffordance } from './evasion.js';
import { BRIDGE_DECK_MATERIALS } from '../../world/WalkSurfaces.js';

export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }
export interface Circle { center: Vec3; radius: number }
export interface CombatArena {
  bounds: Bounds3;
  groundY: number;
  surfaces: readonly GroundSurfaceDefinition[];
  colliders: readonly RegionColliderDefinition[];
  routes: readonly RegionRouteDefinition[];
  obstacles: readonly Rect[];
  cameraBasis?: CameraBasis;
  traversalAffordances?: readonly TraversalAffordance[];
  /** Measured native props (bridge decks, rocks) whose standable tops and solid sides complement the authored walk-mesh. */
  supports?: readonly SupportField[];
}

/** Finite empty-cell sentinels: a cell with these values is outside the prop, never NaN/Infinity (the arena is cloned and serialised). */
export const SUPPORT_EMPTY_TOP = -1e9;
export const SUPPORT_EMPTY_BOTTOM = 1e9;

/**
 * A measured, world-space standable top rasterised on a fixed XZ grid; cell index = row * cols + col. A cell is a solid
 * column [bottom, top]; `stand` is 1 where its top faces up with the capsule's headroom clear. A 'deck' (bridge, platform)
 * is a slab, so the space beneath stays open; a 'top' (rock, drum) is solid down to its underside. Where a deck is measured it
 * replaces any authored bridge-deck walk surface and collider, so the rendered deck and the supported height cannot disagree.
 */
export interface SupportField {
  readonly id: string;
  /** Placement id of the prop the field was measured from. */
  readonly ownerId: string;
  readonly kind: 'deck' | 'top';
  readonly minX: number;
  readonly minZ: number;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  /** Lowest occupied underside and highest occupied top: the vertical broadphase. */
  readonly minY: number;
  readonly maxY: number;
  readonly top: readonly number[];
  readonly bottom: readonly number[];
  readonly stand: readonly number[];
}

/** Numerical tolerance of contact: a foot this close above a top, or a top this close above the capsule's rounded bottom, is touching, not clipping. */
const SUPPORT_EPS = 1e-4;
/** Standing samples: centre, four axis points and (when measured supports exist) four diagonals on the capsule rim. */
const POSE_OFFSETS: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]];
const POSE_AXIS_SAMPLES = 5;

/** Which support heights a jump may land on, and which capsule has to fit there. Heights are relative to `fromY`. */
export interface LandingQuery {
  readonly fromY: number;
  readonly maxRise: number;
  readonly maxDrop: number;
  readonly radius: number;
  readonly height: number;
}
/** Where a straight grounded walk leaves its support: the last supported pose and the lower pose it would fall to. */
export interface EdgeDrop {
  readonly edge: Vec3;
  readonly landing: Vec3;
}

const MAX_SWEEP_STEP = 0.08;
const MAX_WALK_STEP = 0.45;

export function vec(x: number, y: number, z: number): Vec3 { return { x, y, z }; }
export function distance2(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.z - b.z); }
export function facingFrom(v: Vec3): Vec3 { const n = Math.hypot(v.x, v.z) || 1; return { x: v.x / n, y: 0, z: v.z / n }; }
export function pointInSector(point: Vec3, origin: Vec3, direction: Vec3, range: number, angleDeg: number): boolean {
  const dx = point.x - origin.x, dz = point.z - origin.z, distance = Math.hypot(dx, dz);
  if (distance > range || distance === 0) return false;
  return (dx * direction.x + dz * direction.z) / distance >= Math.cos(angleDeg * Math.PI / 360);
}
export function circleHits(circle: Circle, rect: Rect): boolean {
  const x = Math.max(rect.minX, Math.min(circle.center.x, rect.maxX));
  const z = Math.max(rect.minZ, Math.min(circle.center.z, rect.maxZ));
  return (circle.center.x - x) ** 2 + (circle.center.z - z) ** 2 < circle.radius ** 2;
}

export function arenaFromRegion(region: RegionDefinition, cameraBasis?: CameraBasis): CombatArena {
  const traversalAffordances: TraversalAffordance[] = [];
  for (const route of region.traversalArcs) {
    const action = route.traversal?.kind === 'vault' ? 'staff-vault' : route.traversal?.kind === 'slide' ? 'low-slide' : String(route.traversalActionId);
    if (action !== 'staff-vault' && action !== 'low-slide') continue;
    const points = [route.from, ...route.anchors, route.to];
    traversalAffordances.push({
      kind: action,
      bounds: {
        minX: Math.min(...points.map(point => point.x)), maxX: Math.max(...points.map(point => point.x)),
        minZ: Math.min(...points.map(point => point.z)), maxZ: Math.max(...points.map(point => point.z)),
      },
    });
  }
  return {
    bounds: region.bounds, groundY: region.ground.y, surfaces: region.ground.surfaces,
    colliders: region.ground.colliders, routes: region.traversalArcs, obstacles: [], cameraBasis, traversalAffordances,
  };
}

/** Selects a walkable authored surface at the supplied X/Z. Unsupported space is null. */
export function groundHeightAt(arena: CombatArena, x: number, z: number, nearY: number, includeSupports = true): number | null {
  let bestY: number | null = null, bestError = Infinity;
  for (const surface of arena.surfaces) {
    if (!surface.walkable || !pointInPolygon(surface.points, x, z) || deckSuperseded(arena, surface)) continue;
    const height = surfaceHeight(surface, x, z);
    if (height === null) continue;
    const error = Math.abs(height - nearY);
    if (error < bestError) { bestError = error; bestY = height; }
  }
  const supports = arena.supports;
  if (includeSupports && supports !== undefined) {
    for (let i = 0; i < supports.length; i++) {
      const height = supportStandHeight(supports[i]!, x, z);
      if (height === null) continue;
      const error = Math.abs(height - nearY);
      if (error < bestError) { bestError = error; bestY = height; }
    }
  }
  if (bestY !== null) return bestY;
  if (arena.surfaces.length === 0 && insideBounds(arena.bounds, x, z)) return arena.groundY;
  return null;
}

/** Prefer an accessible ramp over an overlapping flat floor; never change floor layers through a gap. */
function groundedSurfaceHeightAt(arena: CombatArena, x: number, z: number, previousY: number): number | null {
  let bestY: number | null = null;
  for (const surface of arena.surfaces) {
    if (!surface.walkable || !pointInPolygon(surface.points, x, z) || deckSuperseded(arena, surface)) continue;
    const height = surfaceHeight(surface, x, z);
    if (height === null) continue;
    if (Math.abs(height - previousY) > MAX_WALK_STEP) continue;
    if (bestY === null || height > bestY) bestY = height;
  }
  const supports = arena.supports;
  if (supports !== undefined) {
    for (let i = 0; i < supports.length; i++) {
      const height = supportStandHeight(supports[i]!, x, z);
      if (height === null || Math.abs(height - previousY) > MAX_WALK_STEP) continue;
      if (bestY === null || height > bestY) bestY = height;
    }
  }
  if (bestY !== null) return bestY;
  if (arena.surfaces.length === 0 && insideBounds(arena.bounds, x, z)) {
    return Math.abs(arena.groundY - previousY) <= MAX_WALK_STEP ? arena.groundY : null;
  }
  return null;
}

/** Move a grounded circle with a bounded sweep and an explicit body height. */
export function moveCircle(arena: CombatArena, start: Vec3, delta: Vec3, radius: number, height = 1.7): Vec3 {
  const minX = arena.bounds.min.x + radius, maxX = arena.bounds.max.x - radius;
  const minZ = arena.bounds.min.z + radius, maxZ = arena.bounds.max.z - radius;
  if (minX > maxX || minZ > maxZ) return start;
  const length = Math.hypot(delta.x, delta.z);
  const stepSize = Math.max(0.005, Math.min(MAX_SWEEP_STEP, radius * 0.1));
  const steps = Math.max(1, Math.ceil(length / stepSize));
  const stepX = delta.x / steps, stepZ = delta.z / steps;
  let x = start.x, z = start.z, y = groundedSurfaceHeightAt(arena, x, z, start.y) ?? start.y;
  for (let i = 0; i < steps; i++) {
    const nx = clamp(x + stepX, minX, maxX), nz = clamp(z + stepZ, minZ, maxZ);
    const diagonalFloor = groundedSurfaceHeightAt(arena, nx, nz, y);
    if (diagonalFloor !== null && Math.abs(diagonalFloor - y) <= MAX_WALK_STEP && !blocked(arena, { x: nx, y: diagonalFloor, z: nz }, radius, y, height, true)) {
      x = nx; z = nz; y = diagonalFloor;
      continue;
    }
    if (nx !== x) {
      const floor = groundedSurfaceHeightAt(arena, nx, z, y);
      if (floor !== null && Math.abs(floor - y) <= MAX_WALK_STEP && !blocked(arena, { x: nx, y: floor, z }, radius, y, height, true)) { x = nx; y = floor; }
    }
    if (nz !== z) {
      const floor = groundedSurfaceHeightAt(arena, x, nz, y);
      if (floor !== null && Math.abs(floor - y) <= MAX_WALK_STEP && !blocked(arena, { x, y: floor, z: nz }, radius, y, height, true)) { z = nz; y = floor; }
    }
  }
  return { x, y: y + delta.y, z };
}

/** Move an airborne capsule without snapping its Y coordinate to a ground surface. */
export function moveAerialCircle(arena: CombatArena, start: Vec3, delta: Vec3, radius: number, height = 1.7): Vec3 {
  const length = Math.hypot(delta.x, delta.y, delta.z);
  const stepSize = Math.max(0.005, Math.min(MAX_SWEEP_STEP, radius * 0.1));
  const steps = Math.max(1, Math.ceil(length / stepSize));
  const stepX = delta.x / steps, stepY = delta.y / steps, stepZ = delta.z / steps;
  let x = start.x, y = start.y, z = start.z;
  for (let step = 0; step < steps; step++) {
    const nx = clamp(x + stepX, arena.bounds.min.x + radius, arena.bounds.max.x - radius);
    const nz = clamp(z + stepZ, arena.bounds.min.z + radius, arena.bounds.max.z - radius);
    // A measured deck or prop top stops a descent (and a deck underside a rise) instead of letting the body pass through it.
    const ny = clampVerticalToSupport(arena, nx, nz, y, clamp(y + stepY, arena.bounds.min.y, arena.bounds.max.y - height), height);
    if (blocked(arena, { x: nx, y: ny, z: nz }, radius, y, height)) continue;
    x = nx; y = ny; z = nz;
  }
  return { x, y, z };
}

/** Contextual paths cannot slide off their authored line or enter a floor. */
export function isAerialCirclePathClear(arena: CombatArena, start: Vec3, end: Vec3, radius: number, height: number): boolean {
  const delta = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.y, delta.z) / Math.min(MAX_SWEEP_STEP, radius * 0.1)));
  let prior = start;
  for (let step = 0; step <= steps; step++) {
    const point = { x: start.x + delta.x * step / steps, y: start.y + delta.y * step / steps, z: start.z + delta.z * step / steps };
    if (point.x < arena.bounds.min.x + radius || point.x > arena.bounds.max.x - radius || point.z < arena.bounds.min.z + radius || point.z > arena.bounds.max.z - radius || point.y < arena.bounds.min.y || point.y + height > arena.bounds.max.y || blocked(arena, point, radius, prior.y, height)) return false;
    const floor = groundHeightAt(arena, point.x, point.z, point.y, false);
    if (floor !== null && floor > point.y + 1e-6) return false;
    const moved = moveAerialCircle(arena, prior, { x: point.x - prior.x, y: point.y - prior.y, z: point.z - prior.z }, radius, height);
    if (Math.hypot(moved.x - point.x, moved.y - point.y, moved.z - point.z) > 1e-6) return false;
    prior = point;
  }
  return true;
}

/**
 * A planned landing: the centre stands on a standable top at exactly `point.y`, the rounded capsule and its headroom are clear
 * (the sweeps of {@link blocked}), and every rim sample has ground under it: authored ground within 0.15 of the foot, or an
 * occupied measured cell no more than the grounded step-down limit below it. A rim over a sloping rock flank is supported (a
 * round top is a valid landing), a rim over air or a real drop is not.
 */
export function isSupportedCapsulePose(arena: CombatArena, point: Vec3, radius: number, height: number): boolean {
  if (!isAerialCirclePathClear(arena, point, point, radius, height)) return false;
  const centerFloor = groundHeightAt(arena, point.x, point.z, point.y);
  if (centerFloor === null || Math.abs(centerFloor - point.y) > 1e-6) return false;
  const supports = arena.supports;
  const measured = supports !== undefined && supports.length > 0;
  const samples = measured ? POSE_OFFSETS.length : POSE_AXIS_SAMPLES;
  for (let i = 0; i < samples; i++) {
    const offset = POSE_OFFSETS[i]!;
    const x = point.x + offset[0] * radius, z = point.z + offset[1] * radius;
    const floor = groundHeightAt(arena, x, z, point.y, false);
    if (floor !== null && Math.abs(floor - point.y) <= 0.15) continue;
    if (measured && supportOccupied(supports, x, z, point.y - MAX_WALK_STEP)) continue;
    return false;
  }
  return true;
}

const landingScratch: number[] = [];

/**
 * Fills `out` with every standing height at (x, z) that a jump from `query.fromY` may land on, nearest to `fromY` first: an
 * authored surface or a measured deck / prop top within [fromY - maxDrop, fromY + maxRise] whose full capsule fits (footprint
 * support and headroom, as {@link isSupportedCapsulePose}). Returns the count. The caller still sweeps the arc.
 */
export function landingHeightsAt(arena: CombatArena, x: number, z: number, query: LandingQuery, out: number[]): number {
  out.length = 0;
  for (const surface of arena.surfaces) {
    if (!surface.walkable || !pointInPolygon(surface.points, x, z) || deckSuperseded(arena, surface)) continue;
    const height = surfaceHeight(surface, x, z);
    if (height !== null) addLandingCandidate(out, height, query);
  }
  const supports = arena.supports;
  if (supports !== undefined) {
    for (let i = 0; i < supports.length; i++) {
      const height = supportStandHeight(supports[i]!, x, z);
      if (height !== null) addLandingCandidate(out, height, query);
    }
  }
  if (arena.surfaces.length === 0 && insideBounds(arena.bounds, x, z)) addLandingCandidate(out, arena.groundY, query);
  const pose = { x, y: 0, z };
  let kept = 0;
  for (let i = 0; i < out.length; i++) {
    pose.y = out[i]!;
    if (isSupportedCapsulePose(arena, pose, query.radius, query.height)) out[kept++] = out[i]!;
  }
  out.length = kept;
  return kept;
}

/** The reachable standing height nearest to `query.fromY` at (x, z), or null (see {@link landingHeightsAt}). */
export function landingHeightAt(arena: CombatArena, x: number, z: number, query: LandingQuery): number | null {
  return landingHeightsAt(arena, x, z, query, landingScratch) > 0 ? landingScratch[0]! : null;
}

/**
 * The highest standable height under the centre at (x, z) below `belowY` by at most `maxDrop` (authored surface or measured top),
 * with no capsule fit required: where a body that has just stepped off a ledge will land. Null when nothing is there.
 */
function lowerCentreSupportAt(arena: CombatArena, x: number, z: number, belowY: number, maxDrop: number): number | null {
  return restingHeightAt(arena, x, z, belowY - 0.05, belowY - maxDrop);
}

/**
 * Walks the straight grounded path `delta` the way {@link moveCircle} does, but reports where centre support is lost instead of
 * stopping: the last supported pose (`edge`) and the lower centre support just beyond it (`landing`, at the first unsupported
 * step). It needs only a clear horizontal advance at the current foot height and a lower centre support within `maxDrop`;
 * the rounded capsule, a prop still overlapping the rim and lip slide-off are resolved by {@link stepFall} as the body descends.
 * Null when the path ends supported, is walled off, leaves the arena, or has nothing to land on.
 */
export function findEdgeDrop(arena: CombatArena, start: Vec3, delta: Vec3, radius: number, height: number, maxDrop: number): EdgeDrop | null {
  const length = Math.hypot(delta.x, delta.z);
  if (length < 1e-9) return null;
  const stepSize = Math.max(0.005, Math.min(MAX_SWEEP_STEP, radius * 0.1));
  const steps = Math.max(1, Math.ceil(length / stepSize));
  const stepX = delta.x / steps, stepZ = delta.z / steps;
  let x = start.x, z = start.z, y = groundedSurfaceHeightAt(arena, x, z, start.y) ?? start.y;
  for (let i = 0; i < steps; i++) {
    const nx = x + stepX, nz = z + stepZ;
    if (nx < arena.bounds.min.x + radius || nx > arena.bounds.max.x - radius || nz < arena.bounds.min.z + radius || nz > arena.bounds.max.z - radius) return null;
    const floor = groundedSurfaceHeightAt(arena, nx, nz, y);
    if (floor !== null) {
      if (blocked(arena, { x: nx, y: floor, z: nz }, radius, y, height, true)) return null;
      x = nx; z = nz; y = floor;
      continue;
    }
    if (blocked(arena, { x: nx, y, z: nz }, radius, y, height)) return null;
    const lower = lowerCentreSupportAt(arena, nx, nz, y, maxDrop);
    return lower === null ? null : { edge: { x, y, z }, landing: { x: nx, y: lower, z: nz } };
  }
  return null;
}


/** Test a straight grounded capsule path without allowing collision sliding to create a detour. */
export function isCirclePathClear(arena: CombatArena, start: Vec3, end: Vec3, radius: number, height = 1.7): boolean {
  const distance = distance2(start, end);
  const stepSize = Math.max(0.005, Math.min(MAX_SWEEP_STEP, radius * 0.1));
  const steps = Math.max(1, Math.ceil(distance / stepSize));
  let previousY = groundedSurfaceHeightAt(arena, start.x, start.z, start.y) ?? start.y;
  for (let step = 1; step <= steps; step++) {
    const ratio = step / steps;
    const x = start.x + (end.x - start.x) * ratio;
    const z = start.z + (end.z - start.z) * ratio;
    if (x < arena.bounds.min.x + radius || x > arena.bounds.max.x - radius || z < arena.bounds.min.z + radius || z > arena.bounds.max.z - radius) return false;
    const y = groundedSurfaceHeightAt(arena, x, z, previousY);
    if (y === null || Math.abs(y - previousY) > MAX_WALK_STEP || blocked(arena, { x, y, z }, radius, previousY, height, true)) return false;
    previousY = y;
  }
  return true;
}

/** Returns an authored traversal route near a point, without treating it as a walkable shortcut. */
export function traversalRouteAt(arena: CombatArena, point: Vec3, radius = 0.75): RegionRouteDefinition | null {
  let best: RegionRouteDefinition | null = null, bestDistance = Infinity;
  for (const route of arena.routes) {
    const points = [route.from, ...route.anchors, route.to];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      const d = distancePointToSegment(point, a, b);
      if (d <= radius && d < bestDistance) { best = route; bestDistance = d; }
    }
  }
  return best;
}

function blocked(arena: CombatArena, point: Vec3, radius: number, previousY: number, actorHeight: number, stepping = false): boolean {
  return authoredBlocked(arena, point, radius, previousY, actorHeight, stepping)
    || (arena.supports !== undefined && supportBlocked(arena.supports, point, radius, previousY, actorHeight, stepping));
}

function authoredBlocked(arena: CombatArena, point: Vec3, radius: number, previousY: number, actorHeight: number, stepping = false): boolean {
  if (arena.obstacles.some(rectangle => circleHits({ center: point, radius }, rectangle))) return true;
  for (const collider of arena.colliders) {
    if (!collider.blocksMovement || !verticalOverlap(point.y, previousY, collider, actorHeight)) continue;
    // A measured deck is the walkway: the authored flat bridge floor beneath it never blocks the capsule resting on it.
    if (collider.walkSurfaceId !== undefined && deckColliderSuperseded(arena, collider.walkSurfaceId)) continue;
    const surface = colliderSurface(arena, collider.walkSurfaceId);
    // A grounded capsule can step onto a reachable authored platform lip.
    // Airborne sweeps still collide with the platform's complete solid volume.
    if (stepping && collider.walkSurfaceId && collider.kind === 'box' && collider.halfExtents
      && collider.from.y + collider.halfExtents.y <= Math.min(point.y, previousY) + MAX_WALK_STEP
      && surface?.walkable) continue;
    if (collider.kind === 'box' && collider.halfExtents) {
      const nearestX = clamp(point.x, collider.from.x - collider.halfExtents.x, collider.from.x + collider.halfExtents.x);
      const nearestZ = clamp(point.z, collider.from.z - collider.halfExtents.z, collider.from.z + collider.halfExtents.z);
      if ((point.x - nearestX) ** 2 + (point.z - nearestZ) ** 2 >= radius ** 2) continue;
      if (!surface || pointInPolygon(surface.points, point.x, point.z) || nearestPolygonEdge(surface.points, point.x, point.z) < radius ** 2) return true;
    } else if (collider.to && collider.radius !== undefined) {
      if (distanceToSegment(point, collider.from, collider.to) < radius + collider.radius) return true;
    } else if (collider.radius !== undefined && distance2(point, collider.from) < radius + collider.radius) return true;
  }
  return false;
}
function verticalOverlap(footY: number, previousFootY: number, collider: RegionColliderDefinition, actorHeight: number): boolean {
  const bottom = collider.kind === 'box' && collider.halfExtents
    ? collider.from.y - collider.halfExtents.y
    : Math.min(collider.from.y, collider.to?.y ?? collider.from.y) - (collider.radius ?? 0);
  const top = collider.kind === 'box' && collider.halfExtents
    ? collider.from.y + collider.halfExtents.y
    : Math.max(collider.from.y, collider.to?.y ?? collider.from.y) + (collider.radius ?? 0);
  return Math.max(footY, previousFootY) + actorHeight > bottom + 1e-6 && Math.min(footY, previousFootY) < top - 1e-6;
}
function distancePointToSegment(point: Vec3, start: Vec3, end: Vec3): number {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const projection = lengthSquared === 0 ? 0 : ((point.x - start.x) * dx + (point.y - start.y) * dy + (point.z - start.z) * dz) / lengthSquared;
  const t = clamp(projection, 0, 1);
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t), point.z - (start.z + dz * t));
}
function distanceToSegment(point: Vec3, start: Vec3, end: Vec3): number {
  const dx = end.x - start.x, dz = end.z - start.z, lengthSquared = dx * dx + dz * dz;
  const projection = lengthSquared === 0 ? 0 : ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared;
  const t = clamp(projection, 0, 1);
  return Math.hypot(point.x - (start.x + dx * t), point.z - (start.z + dz * t));
}
function pointInPolygon(points: readonly Vec3[], x: number, z: number): boolean {
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function colliderSurface(arena: CombatArena, id: string | undefined): GroundSurfaceDefinition | undefined {
  if (id === undefined) return undefined;
  for (const surface of arena.surfaces) if (surface.id === id && surface.points.length >= 3) return surface;
  return undefined;
}

const polygonContact = { x: 0, z: 0 };
/** Exact polygon edges keep a ramp cutout open; a platform's bounding rectangle is only its broadphase. */
function nearestPolygonEdge(points: readonly Vec3[], x: number, z: number): number {
  let best = Infinity;
  for (let index = 0; index < points.length; index++) {
    const a = points[index]!, b = points[(index + 1) % points.length]!;
    const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
    const t = length > 0 ? clamp(((x - a.x) * dx + (z - a.z) * dz) / length, 0, 1) : 0;
    const px = a.x + dx * t, pz = a.z + dz * t, distance = (x - px) ** 2 + (z - pz) ** 2;
    if (distance < best) { best = distance; polygonContact.x = px; polygonContact.z = pz; }
  }
  return best;
}
function surfaceHeight(surface: GroundSurfaceDefinition, x: number, z: number): number | null {
  const points = surface.points;
  if (points.length < 3) return surface.elevation;
  // Surface and renderer share the authored polygon fan: [0, i, i + 1].
  const first = points[0]!;
  for (let i = 1; i < points.length - 1; i++) {
    const second = points[i]!, third = points[i + 1]!;
    if (!pointInTriangleXZ(x, z, first, second, third)) continue;
    const ux = second.x - first.x, uy = second.y - first.y, uz = second.z - first.z;
    const vx = third.x - first.x, vy = third.y - first.y, vz = third.z - first.z;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Math.abs(ny) < 1e-8) return surface.elevation;
    return first.y - (nx * (x - first.x) + nz * (z - first.z)) / ny;
  }
  return null;
}
function pointInTriangleXZ(x: number, z: number, a: Vec3, b: Vec3, c: Vec3): boolean {
  const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(denominator) < 1e-10) return false;
  const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
  const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
  return u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8;
}
function insideBounds(bounds: Bounds3, x: number, z: number): boolean {
  return x >= bounds.min.x && x <= bounds.max.x && z >= bounds.min.z && z <= bounds.max.z;
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

function supportIndex(field: SupportField, x: number, z: number): number {
  const column = Math.floor((x - field.minX) / field.cell), row = Math.floor((z - field.minZ) / field.cell);
  return column < 0 || row < 0 || column >= field.cols || row >= field.rows ? -1 : row * field.cols + column;
}

/** The standable top of the field cell under (x, z), or null where the cell is empty or cannot be stood on. */
function supportStandHeight(field: SupportField, x: number, z: number): number | null {
  const index = supportIndex(field, x, z);
  return index < 0 || field.stand[index] !== 1 ? null : field.top[index]!;
}

/** An authored bridge deck whose measured deck lies within this height of it is the same bridge (an overpass or underpass is not). */
const DECK_MATCH = 0.5;
const yieldCache = new WeakMap<readonly SupportField[], Map<string, boolean>>();

/**
 * Whether an authored bridge-deck walk surface (and its floor collider) yields entirely to the measured deck: a deck field has an
 * occupied cell inside the surface footprint at a height within {@link DECK_MATCH} of it. The whole authored footprint then
 * gives way, so the 3.2 m authored width of a 2.1 m log deck, or a plank the measurement missed, never stays walkable in the
 * air. Decided once per support set and surface.
 */
function deckSuperseded(arena: CombatArena, surface: GroundSurfaceDefinition): boolean {
  const supports = arena.supports;
  if (supports === undefined || supports.length === 0 || BRIDGE_DECK_MATERIALS[surface.material] !== true) return false;
  let decided = yieldCache.get(supports);
  if (decided === undefined) { decided = new Map(); yieldCache.set(supports, decided); }
  const known = decided.get(surface.id);
  if (known !== undefined) return known;
  let yields = false;
  for (let f = 0; f < supports.length && !yields; f++) {
    const field = supports[f]!;
    if (field.kind !== 'deck') continue;
    for (let row = 0; row < field.rows && !yields; row++) {
      for (let column = 0; column < field.cols; column++) {
        const top = field.top[row * field.cols + column]!;
        if (top <= SUPPORT_EMPTY_TOP) continue;
        const x = field.minX + (column + 0.5) * field.cell, z = field.minZ + (row + 0.5) * field.cell;
        if (!pointInPolygon(surface.points, x, z)) continue;
        const height = surfaceHeight(surface, x, z);
        if (height !== null && Math.abs(top - height) <= DECK_MATCH) { yields = true; break; }
      }
    }
  }
  decided.set(surface.id, yields);
  return yields;
}

function deckColliderSuperseded(arena: CombatArena, walkSurfaceId: string): boolean {
  if (arena.supports === undefined || arena.supports.length === 0) return false;
  for (let i = 0; i < arena.surfaces.length; i++) {
    const surface = arena.surfaces[i]!;
    if (surface.id === walkSurfaceId) return deckSuperseded(arena, surface);
  }
  return false;
}

function addLandingCandidate(out: number[], height: number, query: LandingQuery): void {
  if (height > query.fromY + query.maxRise + 1e-9 || height < query.fromY - query.maxDrop - 1e-9) return;
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]! - height) < 1e-6) return;
  const distance = Math.abs(height - query.fromY);
  let index = out.length;
  while (index > 0 && Math.abs(out[index - 1]! - query.fromY) > distance) index--;
  out.splice(index, 0, height);
}

/**
 * Whether any solid field cell the capsule touches stands in the capsule's way. Airborne, a cell at horizontal distance d from the
 * axis blocks only above the rounded capsule bottom there (foot + r - sqrt(r^2 - d^2), plus a numerical epsilon), so a round rock
 * near the foot rim does not collide falsely and nothing may be clipped. A grounded step (`stepping`) lets cells up to the step
 * limit pass. With `push`, the first blocking cell also yields the horizontal direction away from it.
 */
function supportBlocked(supports: readonly SupportField[], point: Vec3, radius: number, previousY: number, actorHeight: number, stepping: boolean, push?: { x: number; z: number }): boolean {
  const foot = Math.min(point.y, previousY);
  const high = Math.max(point.y, previousY) + actorHeight - 1e-6;
  const stepLimit = foot + MAX_WALK_STEP;
  for (let f = 0; f < supports.length; f++) {
    const field = supports[f]!;
    if (field.maxY <= foot + SUPPORT_EPS || field.minY >= high) continue;
    const cell = field.cell;
    const firstColumn = Math.max(0, Math.floor((point.x - radius - field.minX) / cell)), lastColumn = Math.min(field.cols - 1, Math.floor((point.x + radius - field.minX) / cell));
    const firstRow = Math.max(0, Math.floor((point.z - radius - field.minZ) / cell)), lastRow = Math.min(field.rows - 1, Math.floor((point.z + radius - field.minZ) / cell));
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        const index = row * field.cols + column;
        const top = field.top[index]!;
        if (top <= foot + SUPPORT_EPS || field.bottom[index]! >= high) continue;
        const nearestX = clamp(point.x, field.minX + column * cell, field.minX + (column + 1) * cell);
        const nearestZ = clamp(point.z, field.minZ + row * cell, field.minZ + (row + 1) * cell);
        const offsetX = point.x - nearestX, offsetZ = point.z - nearestZ, distanceSquared = offsetX * offsetX + offsetZ * offsetZ;
        if (distanceSquared >= radius * radius) continue;
        if (stepping ? top <= stepLimit : top <= foot + radius - Math.sqrt(radius * radius - distanceSquared) + SUPPORT_EPS) continue;
        if (push !== undefined) { push.x = offsetX; push.z = offsetZ; }
        return true;
      }
    }
  }
  return false;
}

/** Whether any measured cell under (x, z) is occupied with its top at or above `minTop` (a flank under the rim, standable or not). */
function supportOccupied(supports: readonly SupportField[], x: number, z: number, minTop: number): boolean {
  for (let i = 0; i < supports.length; i++) {
    const field = supports[i]!;
    const index = supportIndex(field, x, z);
    if (index >= 0 && field.top[index]! > SUPPORT_EMPTY_TOP && field.top[index]! >= minTop) return true;
  }
  return false;
}

/**
 * Clamps a vertical move at (x, z) against the measured field cell under it: a descent stops on the highest standable top at or
 * below the foot (within the numerical epsilon, never above it), a rise stops under a slab's underside. Authored floors are
 * unaffected (their colliders do this already). Without supports the target is returned unchanged.
 */
export function clampVerticalToSupport(arena: CombatArena, x: number, z: number, fromY: number, toY: number, height: number): number {
  const supports = arena.supports;
  if (supports === undefined || supports.length === 0 || toY === fromY) return toY;
  let result = toY;
  for (let f = 0; f < supports.length; f++) {
    const field = supports[f]!;
    const index = supportIndex(field, x, z);
    if (index < 0 || field.top[index]! <= SUPPORT_EMPTY_TOP) continue;
    if (toY < fromY) {
      // Only a standable cell is ever rested on, so a clamp can never leave the body hanging on a lip it cannot stand on.
      const top = field.top[index]!;
      if (field.stand[index] === 1 && top <= fromY + SUPPORT_EPS && top > result) result = top;
    } else {
      const ceiling = field.bottom[index]! - height;
      if (field.bottom[index]! >= fromY + height - 1e-6 && ceiling < result) result = Math.max(fromY, ceiling);
    }
  }
  return result;
}

/**
 * The resting contact of a body whose centre is at (x, z) moving from foot `fromY` down to `toY`: the highest standable height
 * (authored walk surface or measured top) with toY <= height <= fromY + contact allowance, else null. This is the grounded-stance
 * convention ({@link moveCircle} also stands a capsule on its centre): a body resting here is supported even where part of its
 * circle overhangs an edge. With `radius` and `height` the whole capsule must also fit at that height (no solid in its way, so
 * no resting under a low slab); planned jump landings additionally check footprint support via {@link isSupportedCapsulePose}.
 */
export function restingHeightAt(arena: CombatArena, x: number, z: number, fromY: number, toY: number, radius?: number, height?: number): number | null {
  let best: number | null = null;
  const limit = fromY + SUPPORT_EPS;
  for (const surface of arena.surfaces) {
    if (!surface.walkable || !pointInPolygon(surface.points, x, z) || deckSuperseded(arena, surface)) continue;
    const candidate = surfaceHeight(surface, x, z);
    if (candidate !== null && candidate >= toY - 1e-9 && candidate <= limit && (best === null || candidate > best) && capsuleFits(arena, x, z, candidate, radius, height)) best = candidate;
  }
  const supports = arena.supports;
  if (supports !== undefined) {
    for (let i = 0; i < supports.length; i++) {
      const candidate = supportStandHeight(supports[i]!, x, z);
      if (candidate !== null && candidate >= toY - 1e-9 && candidate <= limit && (best === null || candidate > best) && capsuleFits(arena, x, z, candidate, radius, height)) best = candidate;
    }
  }
  if (best === null && arena.surfaces.length === 0 && insideBounds(arena.bounds, x, z) && arena.groundY >= toY - 1e-9 && arena.groundY <= limit && capsuleFits(arena, x, z, arena.groundY, radius, height)) best = arena.groundY;
  return best;
}

const restPoint = { x: 0, y: 0, z: 0 };
/** Whether a capsule standing at (x, h, z) overlaps no solid; trivially true when no capsule was given. */
function capsuleFits(arena: CombatArena, x: number, z: number, h: number, radius: number | undefined, height: number | undefined): boolean {
  if (radius === undefined || height === undefined) return true;
  restPoint.x = x; restPoint.y = h; restPoint.z = z;
  // Grounded semantics (as moveCircle stands the body): a platform lip or prop within the step limit does not stand in its way.
  return !blocked(arena, restPoint, radius, h, height, true);
}

/** One {@link stepFall}: the new pose and whether the body came to rest on a support. */
export interface FallStep { x: number; y: number; z: number; landed: boolean }
const lipPush = { x: 0, z: 0 };
/** Slide-off per sub-step (3 cm: under 2 m/s at the fixed step), one push each, so leaving a ledge never jumps the body. */
const FALL_PUSH = 0.03;
const FALL_PUSHES_PER_STEP = 1;

/**
 * Falls a body vertically by `dy` (negative). The fall ends at the first {@link restingHeightAt} under the centre (`landed`).
 * Where the circle's rim hangs on the lip of a solid measured cell that cannot be stood on, the body slides off it a few
 * centimetres per sub-step (directly away from the cell) so the fall never stops mid-air; it is never teleported outward or
 * snapped to a higher surface. A lip that is an authored collider holds the body (the engine's existing contact).
 */
export function stepFall(arena: CombatArena, start: Vec3, dy: number, radius: number, height: number, out: FallStep): FallStep {
  const steps = Math.max(1, Math.ceil(Math.abs(dy) / MAX_SWEEP_STEP));
  const stepY = dy / steps;
  let x = start.x, y = start.y, z = start.z;
  out.landed = false;
  for (let step = 0; step < steps; step++) {
    const ny = Math.max(arena.bounds.min.y, y + stepY);
    const rest = restingHeightAt(arena, x, z, y, ny, radius, height);
    if (rest !== null) { y = rest; out.landed = true; break; }
    const supports = arena.supports;
    for (let push = 0; push < FALL_PUSHES_PER_STEP && supports !== undefined && supportBlocked(supports, { x, y: ny, z }, radius, y, height, false, lipPush); push++) {
      const length = Math.hypot(lipPush.x, lipPush.z);
      const directionX = length > 1e-9 ? lipPush.x / length : 1, directionZ = length > 1e-9 ? lipPush.z / length : 0;
      const move = Math.min(FALL_PUSH, Math.max(0.01, radius - length + 0.01));
      const nx = clamp(x + directionX * move, arena.bounds.min.x + radius, arena.bounds.max.x - radius);
      const nz = clamp(z + directionZ * move, arena.bounds.min.z + radius, arena.bounds.max.z - radius);
      if (authoredBlocked(arena, { x: nx, y: ny, z: nz }, radius, y, height)) break;
      x = nx; z = nz;
    }
    if (!blocked(arena, { x, y: ny, z }, radius, y, height)) y = ny;
  }
  out.x = x; out.y = y; out.z = z;
  return out;
}

/** Physical surface under a confirmed swept impact, not the projectile centre offset by its radius. */
export interface SolidContact {
  readonly position: { x: number; y: number; z: number };
  readonly normal: { x: number; y: number; z: number };
  kind: 'solid' | 'ground';
  surfaceId: string;
}

function keepContact(out:SolidContact,point:Vec3,x:number,y:number,z:number,best:number,id:string,kind:SolidContact['kind']):number{
  const dx=point.x-x,dy=point.y-y,dz=point.z-z,distance=Math.hypot(dx,dy,dz);
  if(distance>=best)return best;
  out.position.x=x;out.position.y=y;out.position.z=z;
  out.normal.x=distance>1e-9?dx/distance:0;out.normal.y=distance>1e-9?dy/distance:1;out.normal.z=distance>1e-9?dz/distance:0;
  out.surfaceId=id;out.kind=kind;
  return distance;
}
function polygonSlabContact(out: SolidContact, point: Vec3, surface: GroundSurfaceDefinition, bottom: number, top: number, best: number, id: string): number {
  const edgeDistance = nearestPolygonEdge(surface.points, point.x, point.z);
  const inside = pointInPolygon(surface.points, point.x, point.z);
  let x = inside ? point.x : polygonContact.x, z = inside ? point.z : polygonContact.z;
  let y = clamp(point.y, bottom, top);
  if (inside && y === point.y) {
    const vertical = Math.min(point.y - bottom, top - point.y);
    if (vertical * vertical <= edgeDistance) y = point.y - bottom < top - point.y ? bottom : top;
    else { x = polygonContact.x; z = polygonContact.z; }
  }
  return keepContact(out, point, x, y, z, best, id, 'solid');
}
function boxContact(out:SolidContact,point:Vec3,minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number,best:number,id:string):number{
  let x=clamp(point.x,minX,maxX),y=clamp(point.y,minY,maxY),z=clamp(point.z,minZ,maxZ);
  if(x===point.x&&y===point.y&&z===point.z){
    const dx=Math.min(x-minX,maxX-x),dy=Math.min(y-minY,maxY-y),dz=Math.min(z-minZ,maxZ-z);
    if(dx<=dy&&dx<=dz)x=x-minX<maxX-x?minX:maxX;
    else if(dy<=dz)y=y-minY<maxY-y?minY:maxY;
    else z=z-minZ<maxZ-z?minZ:maxZ;
  }
  return keepContact(out,point,x,y,z,best,id,'solid');
}

/** Allocation-free contact projection over the same authored solids and measured prop cells used by movement. */
export function nearestSolidContact(arena:CombatArena,point:Vec3,radius:number,out:SolidContact):boolean{
  const limit=radius+.08;
  let best=limit;
  for(const collider of arena.colliders){
    if(!collider.blocksMovement||collider.walkSurfaceId!==undefined&&deckColliderSuperseded(arena,collider.walkSurfaceId))continue;
    const c=collider.from,h=collider.halfExtents;
    if(collider.kind==='box'&&h){
      const surface = colliderSurface(arena, collider.walkSurfaceId);
      best = surface
        ? polygonSlabContact(out, point, surface, c.y-h.y, c.y+h.y, best, collider.id)
        : boxContact(out,point,c.x-h.x,c.x+h.x,c.y-h.y,c.y+h.y,c.z-h.z,c.z+h.z,best,collider.id);
    }else if(collider.radius!==undefined){
      const end=collider.to??c,dx=end.x-c.x,dz=end.z-c.z,length=dx*dx+dz*dz;
      const t=length>0?clamp(((point.x-c.x)*dx+(point.z-c.z)*dz)/length,0,1):0;
      const cx=c.x+dx*t,cz=c.z+dz*t,ox=point.x-cx,oz=point.z-cz,distance=Math.hypot(ox,oz),r=collider.radius;
      const scale=distance>r?r/distance:1;
      best=keepContact(out,point,cx+ox*scale,clamp(point.y,Math.min(c.y,end.y)-r,Math.max(c.y,end.y)+r),cz+oz*scale,best,collider.id,'solid');
    }
  }
  if(arena.supports)for(const field of arena.supports){
    if(point.y+limit<field.minY||point.y-limit>field.maxY)continue;
    const cell=field.cell;
    const c0=Math.max(0,Math.floor((point.x-limit-field.minX)/cell)),c1=Math.min(field.cols-1,Math.floor((point.x+limit-field.minX)/cell));
    const r0=Math.max(0,Math.floor((point.z-limit-field.minZ)/cell)),r1=Math.min(field.rows-1,Math.floor((point.z+limit-field.minZ)/cell));
    for(let row=r0;row<=r1;row++)for(let col=c0;col<=c1;col++){
      const index=row*field.cols+col,top=field.top[index]!,bottom=field.bottom[index]!;
      if(top<=SUPPORT_EMPTY_TOP||bottom>=SUPPORT_EMPTY_BOTTOM)continue;
      best=boxContact(out,point,field.minX+col*cell,field.minX+(col+1)*cell,bottom,top,field.minZ+row*cell,field.minZ+(row+1)*cell,best,field.ownerId);
    }
  }
  for(const surface of arena.surfaces){
    if(!surface.walkable||deckSuperseded(arena,surface)||!pointInPolygon(surface.points,point.x,point.z))continue;
    const y=surfaceHeight(surface,point.x,point.z);
    if(y===null||Math.abs(point.y-y)>=best)continue;
    best=keepContact(out,point,point.x,y,point.z,best,surface.id,'ground');
    const a=surface.points[0]!;
    for(let i=1;i<surface.points.length-1;i++){
      const b=surface.points[i]!,c=surface.points[i+1]!;
      if(!pointInTriangleXZ(point.x,point.z,a,b,c))continue;
      const ux=b.x-a.x,uy=b.y-a.y,uz=b.z-a.z,vx=c.x-a.x,vy=c.y-a.y,vz=c.z-a.z;
      const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,n=Math.hypot(nx,ny,nz)*(ny<0?-1:1);
      if(Math.abs(n)>1e-9){out.normal.x=nx/n;out.normal.y=ny/n;out.normal.z=nz/n;}
      break;
    }
  }
  return best<limit;
}

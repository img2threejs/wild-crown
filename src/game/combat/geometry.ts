import type { Bounds3, GroundSurfaceDefinition, RegionColliderDefinition, RegionDefinition, RegionRouteDefinition, Vec3 } from '../contracts.js';
import type { CameraBasis } from './CombatEngine.js';
import type { TraversalAffordance } from './evasion.js';

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
    const action = String(route.traversalActionId);
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
export function groundHeightAt(arena: CombatArena, x: number, z: number, nearY: number): number | null {
  let bestY: number | null = null, bestError = Infinity;
  for (const surface of arena.surfaces) {
    if (!surface.walkable || !pointInPolygon(surface.points, x, z)) continue;
    const height = surfaceHeight(surface, x, z);
    if (height === null) continue;
    const error = Math.abs(height - nearY);
    if (error < bestError) { bestError = error; bestY = height; }
  }
  if (bestY !== null) return bestY;
  if (arena.surfaces.length === 0 && insideBounds(arena.bounds, x, z)) return arena.groundY;
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
  let x = start.x, z = start.z, y = groundHeightAt(arena, x, z, start.y) ?? start.y;
  for (let i = 0; i < steps; i++) {
    const nx = clamp(x + stepX, minX, maxX), nz = clamp(z + stepZ, minZ, maxZ);
    const diagonalFloor = groundHeightAt(arena, nx, nz, y);
    if (diagonalFloor !== null && Math.abs(diagonalFloor - y) <= MAX_WALK_STEP && !blocked(arena, { x: nx, y: diagonalFloor, z: nz }, radius, y, height)) {
      x = nx; z = nz; y = diagonalFloor;
      continue;
    }
    if (nx !== x) {
      const floor = groundHeightAt(arena, nx, z, y);
      if (floor !== null && Math.abs(floor - y) <= MAX_WALK_STEP && !blocked(arena, { x: nx, y: floor, z }, radius, y, height)) { x = nx; y = floor; }
    }
    if (nz !== z) {
      const floor = groundHeightAt(arena, x, nz, y);
      if (floor !== null && Math.abs(floor - y) <= MAX_WALK_STEP && !blocked(arena, { x, y: floor, z: nz }, radius, y, height)) { z = nz; y = floor; }
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
    const ny = clamp(y + stepY, arena.bounds.min.y, arena.bounds.max.y - height);
    const nz = clamp(z + stepZ, arena.bounds.min.z + radius, arena.bounds.max.z - radius);
    if (blocked(arena, { x: nx, y: ny, z: nz }, radius, y, height)) continue;
    x = nx; y = ny; z = nz;
  }
  return { x, y, z };
}

/** Test a straight grounded capsule path without allowing collision sliding to create a detour. */
export function isCirclePathClear(arena: CombatArena, start: Vec3, end: Vec3, radius: number, height = 1.7): boolean {
  const distance = distance2(start, end);
  const stepSize = Math.max(0.005, Math.min(MAX_SWEEP_STEP, radius * 0.1));
  const steps = Math.max(1, Math.ceil(distance / stepSize));
  let previousY = start.y;
  for (let step = 1; step <= steps; step++) {
    const ratio = step / steps;
    const x = start.x + (end.x - start.x) * ratio;
    const z = start.z + (end.z - start.z) * ratio;
    if (x < arena.bounds.min.x + radius || x > arena.bounds.max.x - radius || z < arena.bounds.min.z + radius || z > arena.bounds.max.z - radius) return false;
    const y = groundHeightAt(arena, x, z, previousY);
    if (y === null || Math.abs(y - previousY) > MAX_WALK_STEP || blocked(arena, { x, y, z }, radius, previousY, height)) return false;
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

function blocked(arena: CombatArena, point: Vec3, radius: number, previousY: number, actorHeight: number): boolean {
  if (arena.obstacles.some(rectangle => circleHits({ center: point, radius }, rectangle))) return true;
  for (const collider of arena.colliders) {
    if (!collider.blocksMovement || !verticalOverlap(point.y, previousY, collider, actorHeight)) continue;
    if (collider.kind === 'box' && collider.halfExtents) {
      const nearestX = clamp(point.x, collider.from.x - collider.halfExtents.x, collider.from.x + collider.halfExtents.x);
      const nearestZ = clamp(point.z, collider.from.z - collider.halfExtents.z, collider.from.z + collider.halfExtents.z);
      if ((point.x - nearestX) ** 2 + (point.z - nearestZ) ** 2 < radius ** 2) return true;
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

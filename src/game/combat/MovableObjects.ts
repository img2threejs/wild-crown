import type { ActorId, Vec3 } from '../contracts.js';
import type { EngineState, LiveMovableObject } from './CombatEngine.js';
import { distance2, moveCircle, vec } from './geometry.js';

export function pointInPolygonXZ(point: Vec3, points: readonly Vec3[]): boolean {
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if ((a.z > point.z) !== (b.z > point.z) && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function movableObjectOccupied(state: EngineState, object: LiveMovableObject, position: Vec3, initiatorId: ActorId): boolean {
  const definition = object.authored;
  for (const actor of state.actors) {
    if (!actor.visible || actor.id === initiatorId || actor.id === definition.effect.targetActorInstanceId || distance2(actor.position, definition.from) <= definition.radiusMeters) continue;
    if (distance2(actor.position, position) < definition.radiusMeters + actor.radius) return true;
  }
  return false;
}

/** Shared read-only preflight for command acceptance and the eventual object transaction. */
export function movableObjectPathClear(state: EngineState, object: LiveMovableObject, initiatorId: ActorId): boolean {
  const definition = object.authored;
  const surface = state.arena.surfaces.find(candidate => candidate.id === definition.supportSurfaceId && candidate.walkable);
  if (!surface || !pointInPolygonXZ(definition.from, surface.points) || !pointInPolygonXZ(definition.to, surface.points)) return false;
  let previous = definition.from;
  for (let index = 1; index <= definition.animationTicks; index++) {
    const progress = index / definition.animationTicks;
    const desired = vec(definition.from.x + (definition.to.x - definition.from.x) * progress, definition.from.y + (definition.to.y - definition.from.y) * progress, definition.from.z + (definition.to.z - definition.from.z) * progress);
    const swept = moveCircle(state.arena, previous, vec(desired.x - previous.x, desired.y - previous.y, desired.z - previous.z), definition.radiusMeters, .3);
    if (distance2(swept, desired) > .02 || Math.abs(swept.y - desired.y) > .12 || !pointInPolygonXZ(swept, surface.points) || movableObjectOccupied(state, object, swept, initiatorId)) return false;
    previous = swept;
  }
  return true;
}

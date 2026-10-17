import type { ActorId, RegionId } from '../contracts.js';
import type { AttackDefinition, AuthoredBossPhase, BossEncounterDefinition } from './content.js';
import type { HazardDefinition } from './evasion.js';

/** One telegraphed attack: hazard shape plus windup/commit/active/recovery ticks; extras (element, lunge, onHit…) are spread on top. */
export function strike(id: string, bossId: ActorId, cue: string, shape: Pick<HazardDefinition, 'kind' | 'width' | 'depth' | 'radius' | 'heightAboveGround' | 'damage' | 'hitGroup'>, windup = 42, commit = 12, active = 8, recovery = 46): AttackDefinition {
  return {
    id, bossId, cue, windupTicks: windup, commitTicks: commit, activeTicks: active, recoveryTicks: recovery,
    interruptibleBy: ['root_tether', 'heavy', 'charged_heavy', 'ferocity', 'corruption'],
    hazard: { ...shape, bounds: { min: { x: -shape.width / 2 - shape.radius, y: -.2, z: -shape.depth / 2 - shape.radius }, max: { x: shape.width / 2 + shape.radius, y: 5, z: shape.depth / 2 + shape.radius } } },
  };
}

/** An encounter around one boss actor; wildlife trial maps override `id` and `actorIds` and set `encounterFamily: 'wildlife'`. */
export function boss(id: ActorId, regionId: RegionId, phases: readonly AuthoredBossPhase[], largeActors: readonly ActorId[] = [], playerOnlyCounters: readonly string[] = ['player-dodge', 'player-light', 'player-heavy']): BossEncounterDefinition {
  return { id: 'encounter-' + id, regionId, bossId: id, actorIds: ['aren', id], phases, largeActors, playerOnlyCounters, safeAbsenceResolution: 'subdued' };
}

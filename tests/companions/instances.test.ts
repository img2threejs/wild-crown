import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, CompanionId, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { companionCommand, configureCompanionSlots, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -5, y: -2, z: -5 }, max: { x: 5, y: 5, z: 5 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 }, { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }],
  elevation: 0, walkable: true, material: 'stone', colliderId: 'floor',
};
function actor(id: string, archetypeId: string, allegiance: string): CombatActor {
  return {
    id: id as ActorId, archetypeId: archetypeId as ActorId, species: archetypeId, allegiance,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 },
    actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100, corruption: 100,
    visible: true, downed: false, possessed: false, possessedUntil: 0, radius: 0.3, collisionHeight: 1.6,
    maxVitality: 100, large: false, aerial: false, recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0,
    actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor;
}
function engine(actors: CombatActor[]): EngineState {
  const slots = { utility: 'koro' as CompanionId };
  const region = { id: 'blood-bamboo-valley', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [] };
  return {
    tick: 1, runId: 'instance-test', playerId: 'aren', targetId: 'poacher-scout', regionId: 'blood-bamboo-valley', encounter: null,
    worldFacts: {}, actors, arena: arenaFromRegion(region as never), companionState: createCompanionState(slots), companionSlots: slots,
    events: [], traversalGates: [],
  } as unknown as EngineState;
}

describe('canonical companion archetype resolution', () => {
  it('commands the unique authored Koro instance and emits its runtime actor/target IDs', () => {
    const state = engine([
      actor('aren', 'aren', 'player'), actor('bamboo-koro', 'koro', 'ally'), actor('poacher-scout-instance', 'poacher-scout', 'hostile'),
    ]);
    expect(configureCompanionSlots(state, { utility: 'koro' })).toBe(true);
    expect(companionCommand(state, 'koro', 'search', 'poacher-scout' as ActorId)).toBe(true);
    expect(state.companionState.slots.koro?.targetId).toBe('poacher-scout-instance');
    stepCompanions(state);
    const event = state.events.find(candidate => candidate.kind === 'companion' && candidate.message === 'Track');
    expect(event?.actorId).toBe('bamboo-koro');
    expect(event?.targetId).toBe('poacher-scout-instance');
  });

  it('refuses an ambiguous canonical archetype but exact runtime actor IDs stay addressable', () => {
    const clones = engine([
      actor('aren', 'aren', 'player'), actor('bamboo-koro-a', 'koro', 'ally'), actor('bamboo-koro-b', 'koro', 'ally'),
      actor('poacher-scout-a', 'poacher-scout', 'hostile'), actor('poacher-scout-b', 'poacher-scout', 'hostile'),
    ]);
    expect(configureCompanionSlots(clones, { utility: 'koro' })).toBe(false);
    expect(clones.companionState.utility).toBe('koro');
    expect(companionCommand(clones, 'koro', 'search', 'poacher-scout' as ActorId)).toBe(false);
    expect(clones.companionState.slots.koro?.targetId).toBeUndefined();

    const explicit = engine([
      actor('aren', 'aren', 'player'), actor('koro', 'koro', 'ally'), actor('bamboo-koro-b', 'koro', 'ally'),
      actor('poacher-scout-instance', 'poacher-scout', 'hostile'),
    ]);
    expect(configureCompanionSlots(explicit, { utility: 'koro' })).toBe(true);
    expect(companionCommand(explicit, 'koro', 'search', 'poacher-scout-instance' as ActorId)).toBe(true);
  });
});

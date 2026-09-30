import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, CompanionId, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState, LiveMovableObject } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { companionCommand, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -5, y: -2, z: -5 }, max: { x: 5, y: 5, z: 5 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 }, { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }],
  elevation: 0, walkable: true, material: 'soil', colliderId: 'floor',
};
function actor(id: string, archetypeId: string, position: Vec3, allegiance: string): CombatActor {
  return {
    id: id as ActorId, archetypeId: archetypeId as ActorId, species: archetypeId, allegiance, position,
    velocity: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 }, actionId: 'idle', phase: 'idle', normalizedTime: 0,
    vitality: 100, ferocity: 100, corruption: 100, visible: true, downed: false, possessed: false, possessedUntil: 0,
    radius: 0.3, collisionHeight: 1.6, maxVitality: 100, large: false, aerial: false, recoveringUntil: 0,
    invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor;
}
function object(phase: LiveMovableObject['phase']): LiveMovableObject {
  return {
    objectId: 'camp-loose-snare', phase, position: { x: 0, y: 0, z: 0 },
    authored: {
      id: 'camp-loose-snare', assetId: 'camp-snare', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 },
      supportSurfaceId: 'floor', radiusMeters: 0.75, animationTicks: 18, requiredCompanionId: 'koro',
      koroInteractionId: 'camp-loose-snare', playerInteractionId: 'camp-snare-player', movedFactId: 'camp_snare_moved',
      requiredFacts: [], effect: { kind: 'distraction', targetActorInstanceId: 'poacher-scout-instance', radiusMeters: 4, interruptRangedWindupTicks: 12 },
    },
  };
}
function engine(movable: LiveMovableObject): EngineState {
  const slots = { utility: 'koro' as CompanionId };
  const region = { id: 'blood-bamboo-valley', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [] };
  return {
    tick: 1, runId: 'movable-test', regionId: 'blood-bamboo-valley', playerId: 'aren', targetId: 'poacher-scout-instance',
    encounter: null, worldFacts: {}, actors: [actor('aren', 'aren', { x: 0, y: 0, z: 0 }, 'player'), actor('bamboo-koro', 'koro', { x: 0, y: 0, z: 0 }, 'ally'), actor('poacher-scout-instance', 'poacher-scout', { x: 2, y: 0, z: 0 }, 'hostile')],
    arena: arenaFromRegion(region as never), movableObjects: [movable], companionState: createCompanionState(slots), companionSlots: slots,
    events: [], worldEvents: [], traversalGates: [],
  } as unknown as EngineState;
}

describe('Koro movable-object command', () => {
  it('accepts only a registered resting object and leaves flight/WorldEvent authority to Core', () => {
    const state = engine(object('resting'));
    const koro = state.actors.find(candidate => candidate.id === 'bamboo-koro')!;
    expect(companionCommand(state, 'koro', 'special', 'camp-loose-snare' as ActorId)).toBe(true);
    expect(state.companionState.tokens.available).toBe(1);
    expect(state.companionState.slots.koro?.readyAt).toBe(76);
    expect(state.companionState.slots.koro?.mode).toBe('stay');
    expect(state.companionState.slots.koro?.targetId).toBe('camp-loose-snare');
    expect(koro.targetId).toBe('camp-loose-snare');
    expect(koro.actionId).toBe('koro-canopy-route');
    expect(state.worldEvents).toEqual([]);

    state.movableObjects[0]!.phase = 'in-flight';
    const heldPosition = { ...koro.position };
    stepCompanions(state);
    expect(koro.position).toEqual(heldPosition);
    expect(state.companionState.slots.koro?.mode).toBe('stay');
    expect(state.worldEvents).toEqual([]);

    state.movableObjects[0]!.phase = 'settled';
    stepCompanions(state);
    expect(state.companionState.slots.koro?.mode).toBe('follow');
    expect(state.companionState.slots.koro?.targetId).toBeUndefined();
    expect(state.worldEvents).toEqual([]);
  });

  it('refuses unknown, in-flight, settled, and non-Koro-owned targets without spending resources', () => {
    for (const phase of ['in-flight', 'settled'] as const) {
      const state = engine(object(phase));
      expect(companionCommand(state, 'koro', 'special', 'camp-loose-snare' as ActorId)).toBe(false);
      expect(state.companionState.tokens.available).toBe(2);
      expect(state.companionState.slots.koro?.readyAt).toBe(0);
    }
    const unknown = engine(object('resting'));
    expect(companionCommand(unknown, 'koro', 'special', 'unregistered-object' as ActorId)).toBe(false);
    expect(unknown.companionState.tokens.available).toBe(2);
    const wrongOwner = engine({ ...object('resting'), authored: { ...object('resting').authored, requiredCompanionId: 'asha' as CompanionId } });
    expect(companionCommand(wrongOwner, 'koro', 'special', 'camp-loose-snare' as ActorId)).toBe(false);
    expect(wrongOwner.companionState.tokens.available).toBe(2);
  });
});

import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, CompanionId, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { commandCompanion, configureCompanion, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

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
  const region = { id: 'blood-bamboo-valley', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [] };
  return {
    tick: 1, worldTick: 1, runId: 'instance-test', playerId: 'aren', targetId: 'poacher-scout', regionId: 'blood-bamboo-valley', encounter: null,
    worldFacts: {}, actors, arena: arenaFromRegion(region as never), companionState: createCompanionState('koro'),
    events: [], traversalGates: [], presentationCues: [], seenWorldKeys: [], worldEvents: [], hazards: [], telegraphs: [], movableObjects: [], chapter: { triggers: [], inside: [], intents: [], traps: [] },
  } as unknown as EngineState;
}

describe('canonical companion archetype resolution', () => {
  it('commands the unique authored Koro instance and emits its runtime actor/target IDs', () => {
    const state = engine([
      actor('aren', 'aren', 'player'), actor('bamboo-koro', 'koro', 'ally'), actor('poacher-scout-instance', 'poacher-scout', 'hostile'),
    ]);
    expect(configureCompanion(state, 'koro')).toBe(true);
    expect(commandCompanion(state, { companionId: 'koro', command: 'focus', target: { kind: 'actor', instanceId: 'poacher-scout' as ActorId } })).toBe(true);
    expect(state.companionState.slots.koro?.targetId).toBe('poacher-scout-instance');
    stepCompanions(state);
    expect(state.companionState.slots.koro?.targetId).toBe('poacher-scout-instance');
  });

  it('refuses an ambiguous canonical archetype but exact runtime actor IDs stay addressable', () => {
    const clones = engine([
      actor('aren', 'aren', 'player'), actor('bamboo-koro-a', 'koro', 'ally'), actor('bamboo-koro-b', 'koro', 'ally'),
      actor('poacher-scout-a', 'poacher-scout', 'hostile'), actor('poacher-scout-b', 'poacher-scout', 'hostile'),
    ]);
    expect(configureCompanion(clones, 'koro')).toBe(false);
    expect(clones.companionState.companionId).toBe('koro');
    expect(commandCompanion(clones, { companionId: 'koro', command: 'focus', target: { kind: 'actor', instanceId: 'poacher-scout' as ActorId } })).toBe(false);
    expect(clones.companionState.slots.koro?.targetId).toBeUndefined();

    const explicit = engine([
      actor('aren', 'aren', 'player'), actor('koro', 'koro', 'ally'), actor('bamboo-koro-b', 'koro', 'ally'),
      actor('poacher-scout-instance', 'poacher-scout', 'hostile'),
    ]);
    expect(configureCompanion(explicit, 'koro')).toBe(true);
    expect(commandCompanion(explicit, { companionId: 'koro', command: 'focus', target: { kind: 'actor', instanceId: 'poacher-scout-instance' as ActorId } })).toBe(true);
    expect(explicit.companionState.slots.koro?.targetId).toBe('poacher-scout-instance');
  });
});

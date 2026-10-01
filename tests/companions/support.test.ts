import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, CompanionId, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { companionCommand, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -5, y: -2, z: -5 }, max: { x: 5, y: 5, z: 5 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 }, { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }],
  elevation: 0, walkable: true, material: 'soil', colliderId: 'floor',
};
function actor(id: string, position: Vec3, allegiance = 'ally'): CombatActor {
  return {
    id: id as ActorId, species: 'animal', allegiance, position, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 },
    actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100, corruption: 100, visible: true, downed: false,
    possessedUntil: 0, radius: 0.3, collisionHeight: 1.6, maxVitality: 100, large: false, aerial: false, recoveringUntil: 0,
    invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor;
}
function engine(companions: { combat?: CompanionId; utility?: CompanionId }): EngineState {
  const region = { id: 'whispering-canopy', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [] };
  const companionState = createCompanionState(companions, 1);
  return {
    tick: 1, worldTick: 1, worldTimeScale: 1, runId: 'support-test', playerId: 'aren', targetId: 'hostile', regionId: 'whispering-canopy', encounter: null,
    worldFacts: {}, actors: [actor('aren', { x: 0, y: 0, z: 0 }, 'player'), ...Object.values(companions).map(id => actor(id, { x: 0, y: 0, z: 0 })), actor('hostile', { x: 0, y: 0, z: 0 }, 'hostile')],
    arena: arenaFromRegion(region as never), movableObjects: [], companionState, companionSlots: companions, events: [], traversalGates: [],
  } as unknown as EngineState;
}

describe('distinct nonlethal companion support', () => {
  it('Asha Defend protects Aren for a bounded window', () => {
    const state = engine({ combat: 'asha' });
    expect(companionCommand(state, 'asha', 'defend')).toBe(true);
    stepCompanions(state);
    expect(state.actors.find(candidate => candidate.id === 'aren')?.invulnerableUntil).toBe(7);
    expect(state.actors.find(candidate => candidate.id === 'aren')?.vitality).toBe(100);
  });

  it('Koro waits through a committed attack, then distracts an open windup without damage', () => {
    const state = engine({ utility: 'koro' });
    const hostile = state.actors.find(candidate => candidate.id === 'hostile')!;
    hostile.phase = 'anticipation';
    expect(companionCommand(state, 'koro', 'special', hostile.id)).toBe(true);
    stepCompanions(state);
    expect(hostile.staggerUntil).toBe(7);
    expect(state.events.at(-1)?.actorId).toBe('koro');

    const eventCount = state.events.length;
    hostile.phase = 'active';
    hostile.staggerUntil = 0;
    state.tick = 91;
    state.worldTick = 91;
    state.companionState.tokens.available = 1;
    expect(companionCommand(state, 'koro', 'special', hostile.id)).toBe(true);
    stepCompanions(state);
    expect(hostile.staggerUntil).toBe(0);
    expect(state.events).toHaveLength(eventCount);
    expect(hostile.vitality).toBe(100);

    state.tick = 92;
    state.worldTick = 92;
    hostile.phase = 'anticipation';
    stepCompanions(state);
    expect(hostile.staggerUntil).toBe(98);
    expect(state.events.at(-1)?.actorId).toBe('koro');
    expect(hostile.vitality).toBe(100);
  });

  it('Sable creates a nonlethal flank opening and Solkar rallies only the authored boss window', () => {
    const sableState = engine({ combat: 'sable' });
    const sableTarget = sableState.actors.find(candidate => candidate.id === 'hostile')!;
    expect(companionCommand(sableState, 'sable', 'special', sableTarget.id)).toBe(true);
    stepCompanions(sableState);
    expect(sableTarget.ferocity).toBe(97);
    expect(sableTarget.vitality).toBe(100);
    expect(sableTarget.corruption).toBe(100);

    const solkarState = engine({ combat: 'solkar' });
    const solkarTarget = solkarState.actors.find(candidate => candidate.id === 'hostile')!;
    solkarState.encounter = { bossId: solkarTarget.id } as unknown as EngineState['encounter'];
    solkarTarget.phase = 'anticipation';
    expect(companionCommand(solkarState, 'solkar', 'special', solkarTarget.id)).toBe(true);
    stepCompanions(solkarState);
    expect(solkarTarget.staggerUntil).toBe(7);
    expect(solkarTarget.vitality).toBe(100);
    expect(solkarTarget.corruption).toBe(100);
  });
});

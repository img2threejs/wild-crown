import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { companionCommand, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -5, y: -1, z: -5 }, max: { x: 5, y: 8, z: 5 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 }, { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }],
  elevation: 0, walkable: true, material: 'soil', colliderId: 'floor',
};
function actor(id: string, position: Vec3, allegiance: string): CombatActor {
  return {
    id: id as ActorId, species: id === 'vara' ? 'hornbill' : 'animal', allegiance, position, velocity: { x: 0, y: 0, z: 0 },
    facing: { x: 1, y: 0, z: 0 }, actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100,
    corruption: 0, visible: true, downed: false, possessedUntil: 0, radius: 0.3, maxVitality: 100, large: false,
    aerial: id === 'vara', recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor;
}

describe('Vara aerial scout mark', () => {
  it('marks and warns a live target without spending a combat token or causing damage', () => {
    const region = { id: 'whispering-canopy', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [] };
    const slots = { scout: 'vara' as const };
    const state = {
      tick: 1, worldTick: 1, worldTimeScale: 1, runId: 'vara-test', playerId: 'aren', targetId: 'hostile', regionId: 'whispering-canopy', encounter: null,
      worldFacts: {}, actors: [actor('aren', { x: 0, y: 0, z: 0 }, 'player'), actor('vara', { x: 0, y: 0, z: 0 }, 'ally'), actor('hostile', { x: 0, y: 0, z: 0 }, 'hostile')],
      arena: arenaFromRegion(region as never), companionState: createCompanionState(slots, 1), companionSlots: slots, events: [], traversalGates: [],
    } as unknown as EngineState;
    expect(companionCommand(state, 'vara', 'focus', 'hostile' as ActorId)).toBe(true);
    expect(state.companionState.tokens.available).toBe(2);
    stepCompanions(state);
    expect(state.actors.find(candidate => candidate.id === 'vara')?.position.y).toBeGreaterThan(0);
    expect(state.actors.find(candidate => candidate.id === 'hostile')?.vitality).toBe(100);
    expect(state.events.some(event => event.actorId === 'vara' && event.message === 'Mark Weakness')).toBe(true);
  });
});

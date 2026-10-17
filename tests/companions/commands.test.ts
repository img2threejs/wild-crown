import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { commandCompanion, createCompanionState } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -10, y: -2, z: -10 }, max: { x: 10, y: 8, z: 10 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane',
  points: [{ x: -10, y: 0, z: -10 }, { x: 10, y: 0, z: -10 }, { x: 10, y: 0, z: 10 }, { x: -10, y: 0, z: 10 }],
  elevation: 0, walkable: true, material: 'soil', colliderId: 'floor',
};
function actor(id: string, position: Vec3, allegiance = 'ally'): CombatActor {
  return { id: id as ActorId, archetypeId: id as ActorId, position, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 }, allegiance, visible: true, downed: false, possessedUntil: 0, vitality: 100 } as unknown as CombatActor;
}
function engine(): EngineState {
  const region = { id: 'greenwake', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [], navigation: { nodes: [] } };
  return {
    tick: 3, worldTick: 3, runId: 'command-test', playerId: 'aren', targetId: 'hostile', worldTimeScale: 1, regionId: 'greenwake', encounter: null, worldFacts: {},
    actors: [
      actor('aren', { x: 0, y: 0, z: 0 }, 'player'), actor('asha', { x: 2, y: 0, z: 0 }),
      actor('koro', { x: 3, y: 1, z: -2 }), actor('vara', { x: -2, y: 0, z: 1 }), actor('hostile', { x: 4, y: 0, z: 0 }, 'hostile'),
    ],
    companionState: createCompanionState('koro'),
    arena: arenaFromRegion(region as never),
    movableObjects: [], events: [], worldEvents: [], traversalGates: [], presentationCues: [], seenWorldKeys: [], hazards: [], telegraphs: [],
    chapter: { triggers: [], inside: [], intents: [], traps: [] },
  } as unknown as EngineState;
}

describe('companion command transitions', () => {
  it('Stay stores position while Follow and Recall clear the target and resume following', () => {
    const state = engine();
    const slot = state.companionState.slots.koro!;
    slot.mode = 'focus'; slot.targetId = 'hostile' as ActorId;
    expect(commandCompanion(state, { companionId: 'koro', command: 'stay' })).toBe(true);
    expect(slot.mode).toBe('stay');
    expect(slot.position).toEqual({ x: 3, y: 1, z: -2 });
    expect(slot.targetId).toBeUndefined();
    expect(commandCompanion(state, { companionId: 'koro', command: 'follow' })).toBe(true);
    expect(slot.mode).toBe('follow');
    slot.mode = 'stay';
    expect(commandCompanion(state, { companionId: 'koro', command: 'recall' })).toBe(true);
    expect(slot.mode).toBe('follow');
  });

  it('Focus and Distract set utility intent and target; distract does not consume a token', () => {
    const state = engine();
    const startingTokens = state.companionState.tokens.available;
    const slot = state.companionState.slots.koro!;
    expect(commandCompanion(state, { companionId: 'koro', command: 'focus', target: { kind: 'actor', instanceId: 'hostile' as ActorId } })).toBe(true);
    expect(slot.mode).toBe('focus');
    expect(slot.targetId).toBe('hostile');
    const tokensAfterFocus = state.companionState.tokens.available;
    state.tick = 80;
    state.worldTick = 80;
    expect(commandCompanion(state, { companionId: 'koro', command: 'distract', target: { kind: 'actor', instanceId: 'hostile' as ActorId } })).toBe(true);
    expect(slot.mode).toBe('distract');
    expect(state.companionState.tokens.available).toBe(tokensAfterFocus);
    expect(startingTokens - tokensAfterFocus).toBe(1);
  });
});

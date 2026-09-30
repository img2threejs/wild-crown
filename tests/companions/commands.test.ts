import { describe, expect, it } from 'bun:test';
import type { ActorId, CompanionId, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { companionCommand, createCompanionState } from '../../src/game/companions/CompanionSystem.js';

function actor(id: string, position: Vec3, allegiance = 'ally'): CombatActor {
  return { id: id as ActorId, position, allegiance, visible: true, downed: false, possessedUntil: 0, vitality: 100 } as unknown as CombatActor;
}
function engine(): EngineState {
  const slots = { combat: 'asha' as CompanionId, utility: 'koro' as CompanionId, scout: 'vara' as const };
  return {
    tick: 3, runId: 'command-test', playerId: 'aren', targetId: 'hostile', actors: [
      actor('aren', { x: 0, y: 0, z: 0 }, 'player'), actor('asha', { x: 2, y: 0, z: 0 }),
      actor('koro', { x: 3, y: 1, z: -2 }), actor('vara', { x: -2, y: 0, z: 1 }), actor('hostile', { x: 4, y: 0, z: 0 }, 'hostile'),
    ],
    companionSlots: slots, companionState: createCompanionState(slots),
  } as unknown as EngineState;
}

describe('companion command transitions', () => {
  it('Stay stores position while Follow and Recall clear the target and resume following', () => {
    const state = engine();
    const slot = state.companionState.slots.koro!;
    slot.mode = 'focus'; slot.targetId = 'hostile' as ActorId;
    expect(companionCommand(state, 'koro', 'stay')).toBe(true);
    expect(slot.mode).toBe('stay');
    expect(slot.position).toEqual({ x: 3, y: 1, z: -2 });
    expect(slot.targetId).toBeUndefined();
    expect(companionCommand(state, 'koro', 'follow')).toBe(true);
    expect(slot.mode).toBe('follow');
    slot.mode = 'stay';
    expect(companionCommand(state, 'koro', 'recall')).toBe(true);
    expect(slot.mode).toBe('follow');
  });

  it('Search and Distract set utility intent and target without consuming support tokens', () => {
    const state = engine();
    const tokens = state.companionState.tokens.available;
    const slot = state.companionState.slots.koro!;
    expect(companionCommand(state, 'koro', 'search', 'hostile' as ActorId)).toBe(true);
    expect(slot.mode).toBe('search');
    expect(slot.targetId).toBe('hostile');
    expect(state.actors.find(candidate => candidate.id === 'koro')?.actionId).toBe('koro-search');
    state.tick = 80;
    expect(companionCommand(state, 'koro', 'distract', 'hostile' as ActorId)).toBe(true);
    expect(slot.mode).toBe('distract');
    expect(state.actors.find(candidate => candidate.id === 'koro')?.actionId).toBe('koro-distract');
    expect(state.companionState.tokens.available).toBe(tokens);
  });
});

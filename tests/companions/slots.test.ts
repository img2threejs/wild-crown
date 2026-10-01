import { describe, expect, it } from 'bun:test';
import type { ActorId, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { configureCompanionSlots, createCompanionState } from '../../src/game/companions/CompanionSystem.js';

function actor(id: string, position: Vec3): CombatActor {
  return {
    id: id as ActorId, species: 'animal', allegiance: 'ally', position,
    visible: true, downed: false, possessedUntil: 0,
  } as unknown as CombatActor;
}
function engine(): EngineState {
  return {
    tick: 12, worldTick: 12, worldTimeScale: 1, actors: [actor('koro', { x: -2, y: 0, z: 1 }), actor('asha', { x: 3, y: 2, z: -1 })],
    companionState: createCompanionState({ utility: 'koro' }), companionSlots: { utility: 'koro' },
  } as unknown as EngineState;
}

describe('companion slot reconciliation', () => {
  it('preserves existing companion resources and never creates absent actors', () => {
    const state = engine();
    state.companionState.slots.koro!.token = 2;
    state.companionState.slots.koro!.readyAt = 99;
    state.companionState.tokens.available = 0;
    state.companionState.bond = 22;
    state.companionState.wardenCall = false;
    expect(configureCompanionSlots(state, { combat: 'asha' })).toBe(true);
    expect(state.companionState.slots.koro).toBeUndefined();
    expect(state.companionState.slots.asha?.position).toEqual({ x: 3, y: 2, z: -1 });
    expect(state.companionState.tokens.available).toBe(0);
    expect(state.companionState.bond).toBe(22);
    expect(state.companionState.wardenCall).toBe(false);
    const before = { ...state.companionState.slots };
    expect(configureCompanionSlots(state, { combat: 'vara' })).toBe(false);
    expect(state.companionState.slots).toEqual(before);
    expect(state.actors.some(candidate => candidate.id === 'vara')).toBe(false);
  });

  it('rejects duplicate role assignments and possessed actors atomically', () => {
    const state = engine();
    expect(configureCompanionSlots(state, { combat: 'koro', utility: 'koro' })).toBe(false);
    state.actors.find(candidate => candidate.id === 'asha')!.possessedUntil = 20;
    expect(configureCompanionSlots(state, { combat: 'asha' })).toBe(false);
    expect(state.companionState.utility).toBe('koro');
  });
});

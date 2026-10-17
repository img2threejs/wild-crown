import { describe, expect, it } from 'bun:test';
import type { ActorId, CompanionId, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { configureCompanion, createCompanionState, normalizeCompanionState } from '../../src/game/companions/CompanionSystem.js';
import { migrateCompanionParty } from '../../src/game/companions/CompanionLoadout.js';

function actor(id: string, position: Vec3): CombatActor {
  return {
    id: id as ActorId, species: 'animal', allegiance: 'ally', position,
    visible: true, downed: false, possessedUntil: 0,
  } as unknown as CombatActor;
}
function engine(): EngineState {
  return {
    tick: 12, worldTick: 12, worldTimeScale: 1, actors: [actor('koro', { x: -2, y: 0, z: 1 }), actor('asha', { x: 3, y: 2, z: -1 })],
    companionState: createCompanionState('koro'),
  } as unknown as EngineState;
}

describe('single companion reconciliation', () => {
  it('replaces the sole companion without granting tokens, Bond or absent actors', () => {
    const state = engine();
    state.companionState.slots.koro!.token = 2;
    state.companionState.slots.koro!.readyAt = 99;
    state.companionState.tokens.available = 0;
    state.companionState.bond = 22;
    state.companionState.wardenCall = false;
    expect(configureCompanion(state, 'asha')).toBe(true);
    expect(state.companionState.slots.koro).toBeUndefined();
    expect(state.companionState.slots.asha?.position).toEqual({ x: 3, y: 2, z: -1 });
    expect(state.companionState.companionId).toBe('asha');
    expect(Object.keys(state.companionState.slots)).toEqual(['asha']);
    expect(state.companionState.tokens.available).toBe(0);
    expect(state.companionState.bond).toBe(22);
    expect(state.companionState.wardenCall).toBe(false);
    const before = { ...state.companionState.slots };
    expect(configureCompanion(state, 'vara')).toBe(false);
    expect(state.companionState.slots).toEqual(before);
    expect(state.actors.some(candidate => candidate.id === 'vara')).toBe(false);
  });

  it('rejects multi-companion payloads and possessed actors atomically', () => {
    const state = engine();
    expect(configureCompanion(state, { combat: 'koro', utility: 'asha' } as unknown as CompanionId)).toBe(false);
    state.actors.find(candidate => candidate.id === 'asha')!.possessedUntil = 20;
    expect(configureCompanion(state, 'asha')).toBe(false);
    expect(state.companionState.companionId).toBe('koro');
    expect(Object.keys(state.companionState.slots)).toEqual(['koro']);
  });

  it('reselecting the same companion cannot reset its recovery or consume another token', () => {
    const state = engine(), slot = state.companionState.slots.koro!;
    slot.readyAt = 99; slot.token = 2;
    state.companionState.tokens.available = 0;
    expect(configureCompanion(state, 'koro')).toBe(true);
    expect(state.companionState.slots.koro).toBe(slot);
    expect(slot.readyAt).toBe(99);
    expect(slot.token).toBe(2);
    expect(state.companionState.tokens.available).toBe(0);
  });

  it('restores only the legacy primary companion and drops retired role fields and jobs', () => {
    const saved = {
      ...createCompanionState(), combat: 'asha', utility: 'koro', scout: 'vara',
      slots: {
        ...createCompanionState('asha').slots,
        ...createCompanionState('koro').slots,
        ...createCompanionState('vara').slots,
      },
    };
    const restored = normalizeCompanionState(saved);
    expect(restored.companionId).toBe('asha');
    expect(Object.keys(restored.slots)).toEqual(['asha']);
    expect('combat' in restored || 'utility' in restored || 'scout' in restored).toBe(false);
  });

  it('migrates old saves by primary, then utility, then scout without mutating the input', () => {
    const old = { combat: 'asha', utility: 'koro', scout: 'vara' };
    expect(migrateCompanionParty(old)).toEqual({ companionId: 'asha' });
    expect(migrateCompanionParty({ utility: 'nyra', scout: 'vara' })).toEqual({ companionId: 'nyra' });
    expect(migrateCompanionParty({ scout: 'vara' })).toEqual({ companionId: 'vara' });
    expect(old).toEqual({ combat: 'asha', utility: 'koro', scout: 'vara' });
  });

  it('rejects mixed, duplicated and unknown saved companion selections', () => {
    expect(migrateCompanionParty({ companionId: 'koro', combat: 'asha', scout: 'vara' })).toBeNull();
    expect(migrateCompanionParty({ combat: 'koro', utility: 'koro', scout: 'vara' })).toBeNull();
    expect(migrateCompanionParty({ companionId: 'unknown' })).toBeNull();
    expect(migrateCompanionParty({ scout: 'asha' })).toBeNull();
  });
});

import { describe, expect, it } from 'bun:test';
import type { ActorId, CompanionId } from '../../src/game/contracts.js';
import { createEngineState, makeActor, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { commandCompanion, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

function fixture(id: CompanionId): EngineState {
  const state = createEngineState();
  state.tick = state.worldTick = 1;
  state.worldTimeScale = 1;
  state.encounter = null;
  state.arena = arenaFromRegion({ id: 'greenwake', bounds: { min: { x: -20, y: -2, z: -20 }, max: { x: 20, y: 10, z: 20 } }, ground: { y: 0, colliders: [], surfaces: [{ id: 'floor', profile: 'plane', points: [{ x: -20, y: 0, z: -20 }, { x: 20, y: 0, z: -20 }, { x: 20, y: 0, z: 20 }, { x: -20, y: 0, z: 20 }], elevation: 0, walkable: true, material: 'soil', colliderId: 'floor' }] }, traversalArcs: [] } as never);
  state.actors = [makeActor('aren', 'human', 'player', { x: 0, y: 0, z: 0 }, false, false, 100), makeActor(id, id === 'vara' ? 'harpy-eagle' : 'wolf', 'ally', { x: 1, y: 0, z: 0 }, false, id === 'vara', 100), makeActor('hostile' as ActorId, 'boar', 'hostile', { x: 3, y: 0, z: 0 }, false, false, 100)];
  state.playerId = 'aren'; state.targetId = 'hostile' as ActorId;
  state.companionState = createCompanionState(id);
  return state;
}
function advance(state: EngineState, ticks: number): void {
  for (let i = 0; i < ticks; i++) { state.tick++; state.worldTick += state.worldTimeScale; stepCompanions(state); }
}
function engage(state: EngineState): void {
  state.encounter = { id: 'live', bossId: 'hostile', actorIds: ['hostile'], phases: [], largeActors: [], playerOnlyCounters: [] } as never;
}

describe('proactive companion support', () => {
  it('supports an engaged threat without an order, preserving one manual token', () => {
    const state = fixture('sable');
    engage(state);
    advance(state, 1);
    expect(state.companionState.slots.sable?.job?.command).toBe('special');
    expect(state.companionState.tokens.available).toBe(1);
    advance(state, 80);
    expect(state.actors[2]!.supportSlow?.factor).toBe(.85);
    expect(state.companionState.tokens.available).toBe(1);
  });

  it('does not spend the final token or aggro an unengaged encounter actor', () => {
    const state = fixture('sable');
    engage(state);
    state.companionState.tokens.available = 1;
    state.companionState.tokens.nextAt = 1000;
    advance(state, 80);
    expect(state.companionState.slots.sable?.job).toBeUndefined();
    expect(state.actors[2]!.supportSlow).toBeUndefined();
    state.companionState.tokens.available = 2;
    state.actors[2]!.motion = { engaged: false } as never;
    advance(state, 80);
    expect(state.companionState.tokens.available).toBe(2);
    expect(state.companionState.slots.sable?.job).toBeUndefined();
    expect(state.worldEvents).toEqual([]);
  });

  it('waits for actual ambient aggro, then supports without requiring a story encounter', () => {
    const state = fixture('sable'), target = state.actors[2]!;
    advance(state, 80);
    expect(target.supportSlow).toBeUndefined();
    expect(state.companionState.tokens.available).toBe(2);
    target.targetId = state.playerId;
    advance(state, 90);
    expect(target.supportSlow?.factor).toBe(.65);
    expect(state.companionState.tokens.available).toBe(1);
    expect(state.encounter).toBeNull();
    expect(target.vitality).toBe(100);
  });

  it('marks freely before attempting a paid dive and does not start story interactions', () => {
    const state = fixture('vara');
    engage(state);
    state.companionState.tokens.available = 1;
    state.companionState.tokens.nextAt = 1000;
    advance(state, 30);
    expect(state.actors[2]!.markState?.sourceId).toBe('vara');
    expect(state.companionState.tokens.available).toBe(1);
    expect(state.companionState.slots.vara?.stormTalon).toBeUndefined();
    expect(state.worldEvents.some(event => event.type === 'semantic-interaction' && event.kind === 'ask')).toBe(false);
  });

  it('freezes active skill progress, contact and token regeneration while paused', () => {
    const state = fixture('sable');
    commandCompanion(state, { companionId: 'sable', command: 'special', target: { kind: 'actor', instanceId: 'hostile' as ActorId } });
    advance(state, 8);
    const progress = state.actors[1]!.normalizedTime;
    const tokens = state.companionState.tokens.available;
    state.worldTimeScale = 0;
    advance(state, 100);
    expect(state.actors[1]!.normalizedTime).toBe(progress);
    expect(state.actors[2]!.ferocity).toBe(100);
    expect(state.companionState.tokens.available).toBe(tokens);
    state.worldTimeScale = 1;
    advance(state, 80);
    expect(state.actors[2]!.supportSlow?.factor).toBe(.65);
  });

  it('samples a finite gesture, lands exactly once, and recall cancels a pending contact', () => {
    const state = fixture('sable');
    commandCompanion(state, { companionId: 'sable', command: 'special', target: { kind: 'actor', instanceId: 'hostile' as ActorId } });
    advance(state, 8);
    const early = state.actors[1]!.normalizedTime;
    advance(state, 12);
    expect(state.actors[1]!.normalizedTime).toBeGreaterThan(early);
    expect(state.actors[2]!.ferocity).toBe(100);
    commandCompanion(state, { companionId: 'sable', command: 'recall' });
    advance(state, 100);
    expect(state.actors[2]!.ferocity).toBe(100);
    advance(state, 600);
    commandCompanion(state, { companionId: 'sable', command: 'special', target: { kind: 'actor', instanceId: 'hostile' as ActorId } });
    advance(state, 100);
    expect(state.actors[2]!.supportSlow?.factor).toBe(.65);
    expect(state.presentationCues.filter(cue => cue.actionId === 'sable-pack-flank' && cue.phase === 'hit')).toHaveLength(1);
    expect(state.actors[1]!.phase).toBe('idle');
    expect(state.actors[1]!.normalizedTime).toBe(0);
  });
});

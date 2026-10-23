import { describe, expect, it } from 'bun:test';
import type { ActorId, CompanionId } from '../../src/game/contracts.js';
import { createEngineState, type CombatActor, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { commandAvailability, commandCompanion, companionOwnerMultiplier, configureCompanion, createCompanionState, shiftCompanionClocks, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

function actor(id: string, allegiance: CombatActor['allegiance'] = 'ally'): CombatActor {
  return { id: id as ActorId, archetypeId: id as ActorId, species: 'animal', allegiance,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 },
    actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, maxVitality: 100, ferocity: 100, corruption: 100,
    visible: true, downed: false, possessedUntil: 0, radius: .3, collisionHeight: 1.6, large: false, aerial: false,
    recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0 } as CombatActor;
}
function engine(id: CompanionId): EngineState {
  const state = createEngineState();
  state.tick = state.worldTick = 1;
  state.encounter = null;
  state.actors = [actor('aren', 'player'), actor(id), actor('hostile', 'hostile')];
  state.playerId = 'aren'; state.targetId = 'hostile' as ActorId;
  state.companionState = createCompanionState(id);
  state.arena = { bounds: { min: { x: -30, y: -2, z: -30 }, max: { x: 30, y: 10, z: 30 } }, groundY: 0, surfaces: [], colliders: [], routes: [], obstacles: [] };
  return state;
}
function advance(state: EngineState, ticks: number): void {
  for (let i = 0; i < ticks; i++) { state.tick++; state.worldTick++; stepCompanions(state); }
}
function cast(state: EngineState, id: CompanionId): void {
  expect(commandCompanion(state, { companionId: id, command: 'focus', target: { kind: 'actor', instanceId: 'hostile' as ActorId } })).toBe(true);
}
const hostile = (state: EngineState) => state.actors[2]!;

describe('bounded, distinct companion benefits', () => {
  it('Koro heals only on native contact, clamps health and does not damage or weaken enemies', () => {
    const state = engine('koro'); state.player.vitality = 40;
    cast(state, 'koro'); stepCompanions(state);
    expect(state.player.vitality).toBe(40);
    advance(state, 60);
    expect(state.player.vitality).toBe(48);
    expect(state.actors[0]!.vitality).toBe(48);
    expect(hostile(state).vitality).toBe(100); expect(hostile(state).ferocity).toBe(100);
    expect(hostile(state).reactionState).toBeUndefined();
    const full = engine('koro'); full.player.vitality = 98;
    cast(full, 'koro'); advance(full, 60); expect(full.player.vitality).toBe(100);
  });
  it('healing cannot reach a distant or downed owner', () => {
    for (const down of [false, true]) {
      const state = engine('koro'); state.player.vitality = 30;
      cast(state, 'koro'); stepCompanions(state);
      if (down) state.actors[0]!.downed = true; else state.actors[0]!.position.x = 25;
      advance(state, 60); expect(state.player.vitality).toBe(30);
    }
  });
  it('Sable slows movement independently without extending a stronger hero slow', () => {
    const state = engine('sable'), target = hostile(state);
    target.crippleFactor = .3; target.crippleUntil = 80;
    cast(state, 'sable'); advance(state, 50);
    expect(target.supportSlow?.factor).toBe(.65);
    expect(target.crippleFactor).toBe(.3); expect(target.crippleUntil).toBe(80);
    expect(target.vitality).toBe(100); expect(target.ferocity).toBe(100);
    advance(state, 250); expect(target.supportSlow).toBeUndefined();
  });
  it('Asha alone stuns briefly and cannot extend an existing reaction or chain control', () => {
    const state = engine('asha'); cast(state, 'asha'); advance(state, 50);
    expect(hostile(state).reactionState?.kind).toBe('stun');
    expect(hostile(state).reactionState?.durationTicks).toBe(60);
    expect(hostile(state).companionControlReadyAt).toBeGreaterThan(state.worldTick);
    const protectedState = engine('asha'); hostile(protectedState).staggerUntil = 500;
    cast(protectedState, 'asha'); advance(protectedState, 50);
    expect(hostile(protectedState).staggerUntil).toBe(500);
    expect(hostile(protectedState).reactionState).toBeUndefined();
  });
  it('boss control is reduced and never cancels its attack', () => {
    const state = engine('asha'); state.encounter = { bossId: hostile(state).id } as never;
    cast(state, 'asha'); advance(state, 50);
    expect(hostile(state).reactionState?.durationTicks).toBe(15);
    expect(hostile(state).reactionState?.cancelsAttack).toBe(false);
    const slow = engine('sable'); slow.encounter = { bossId: hostile(slow).id } as never;
    cast(slow, 'sable'); advance(slow, 50); expect(hostile(slow).supportSlow?.factor).toBe(.85);
  });
  it('Nyra reduces only remaining hero cooldowns, capped per skill, without damage or poise', () => {
    const state = engine('nyra'); state.skillReadyAt = { heavy: 1000, charged_heavy: 1000, judgement: 120, light: 1 };
    cast(state, 'nyra'); advance(state, 60);
    expect(state.skillReadyAt.heavy).toBe(910); expect(state.skillReadyAt.charged_heavy).toBe(910);
    expect(state.skillReadyAt.judgement).toBeGreaterThan(state.tick);
    expect(state.skillReadyAt.judgement).toBeLessThan(120); expect(state.skillReadyAt.light).toBe(1);
    expect(hostile(state).vitality).toBe(100); expect(hostile(state).reactionState).toBeUndefined();
  });
  it('Solkar grants only source-bound power; swapping clears it but does not reset his support cooldown', () => {
    const state = engine('solkar'); state.player.instinct = 40; state.player.vitality = 60;
    cast(state, 'solkar'); advance(state, 60);
    expect(companionOwnerMultiplier(state, 'power')).toBe(1.12);
    expect(companionOwnerMultiplier(state, 'haste')).toBe(1);
    expect(state.player.instinct).toBe(40); expect(state.player.vitality).toBe(60);
    expect(hostile(state).reactionState).toBeUndefined();
    const ready = state.companionState.supportReadyAt.solkar;
    state.actors.push(actor('koro'));
    expect(configureCompanion(state, 'koro')).toBe(true);
    expect(companionOwnerMultiplier(state, 'power')).toBe(1);
    expect(configureCompanion(state, 'solkar')).toBe(true);
    expect(state.companionState.supportReadyAt.solkar).toBe(ready);
    expect(commandAvailability(state, { companionId: 'solkar', command: 'focus', target: { kind: 'actor', instanceId: hostile(state).id } }).available).toBe(false);
  });
  it('owner boons expire, stop on possession, and rebase with checkpoint clocks', () => {
    const state = engine('solkar'); cast(state, 'solkar'); advance(state, 60);
    const deadline = state.companionState.ownerBoon!.untilWorldTick;
    const ready = state.companionState.supportReadyAt.solkar!;
    shiftCompanionClocks(state.companionState, 100);
    expect(state.companionState.ownerBoon!.untilWorldTick).toBe(deadline + 100);
    expect(state.companionState.supportReadyAt.solkar).toBe(ready + 100);
    state.actors[1]!.possessedUntil = state.worldTick + 100;
    expect(companionOwnerMultiplier(state, 'power')).toBe(1);
    state.actors[1]!.possessedUntil = 0;
    state.worldTick = deadline + 100;
    expect(companionOwnerMultiplier(state, 'power')).toBe(1);
  });
});

describe('support contact follows the committed animated motion', () => {
  for (const id of ['asha', 'sable', 'nyra'] as const) {
    it(`${id} travels to contact before applying its unchanged benefit`, () => {
      const state = engine(id), ally = state.actors[1]!;
      ally.position.x = -2;
      state.skillReadyAt.heavy = 1000;
      cast(state, id); stepCompanions(state);
      const skill = state.companionState.slots[id]!.skill!;
      while (state.worldTick < skill.contactAt - 1) advance(state, 1);
      expect(ally.position.x).toBeGreaterThan(-1.2);
      expect(hostile(state).reactionState).toBeUndefined();
      expect(hostile(state).supportSlow).toBeUndefined();
      expect(state.skillReadyAt.heavy).toBe(1000);
      advance(state, 1);
      expect(ally.position.y).toBeCloseTo(0, 5);
      if (id === 'asha') expect(hostile(state).reactionState?.kind).toBe('stun');
      if (id === 'sable') expect(hostile(state).supportSlow?.factor).toBe(.65);
      if (id === 'nyra') expect(state.skillReadyAt.heavy).toBe(910);
      expect(hostile(state).vitality).toBe(100);
    });
  }

  for (const id of ['asha', 'sable', 'nyra'] as const) {
    it(`${id} keeps body clearance when its target advances through the committed endpoint`, () => {
      const state = engine(id), ally = state.actors[1]!, target = hostile(state);
      ally.position.x = -2;
      state.skillReadyAt.heavy = 1000;
      cast(state, id); stepCompanions(state);
      const skill = state.companionState.slots[id]!.skill!;
      while (state.worldTick < skill.contactAt + 6) {
        target.position.x -= .025;
        advance(state, 1);
        expect(Math.hypot(ally.position.x - target.position.x, ally.position.z - target.position.z)).toBeGreaterThanOrEqual(ally.radius + target.radius);
      }
      if (id === 'asha') expect(target.reactionState?.kind).toBe('stun');
      if (id === 'sable') expect(target.supportSlow?.factor).toBe(.65);
      if (id === 'nyra') expect(state.skillReadyAt.heavy).toBe(910);
      expect(target.vitality).toBe(100);
    });
  }

  it('an already-close pounce still separates from a target moving into its stance', () => {
    const state = engine('nyra'), ally = state.actors[1]!, target = hostile(state);
    ally.position.x = -.7;
    state.skillReadyAt.heavy = 1000;
    cast(state, 'nyra'); stepCompanions(state);
    for (let tick = 0; tick < 40; tick++) {
      target.position.x -= .025;
      advance(state, 1);
      expect(Math.hypot(ally.position.x - target.position.x, ally.position.z - target.position.z)).toBeGreaterThanOrEqual(ally.radius + target.radius);
    }
    expect(ally.position.y).toBe(0);
    expect(state.skillReadyAt.heavy).toBe(910);
  });

  it('a committed pounce cannot hit a target that moves away; recall lands on the last safe ground', () => {
    const state = engine('nyra'), ally = state.actors[1]!;
    ally.position.x = -2; state.skillReadyAt.heavy = 1000;
    cast(state, 'nyra'); stepCompanions(state);
    const skill = state.companionState.slots.nyra!.skill!;
    while (state.worldTick < skill.releaseAt + 4) advance(state, 1);
    expect(ally.position.y).toBeGreaterThan(.1);
    expect(commandCompanion(state, { companionId: 'nyra', command: 'recall' })).toBe(true);
    expect(ally.position.y).toBe(0);
    expect(state.companionState.slots.nyra!.skill).toBeUndefined();
    advance(state, 40);
    expect(state.skillReadyAt.heavy).toBe(1000);

    const miss = engine('asha'); miss.actors[1]!.position.x = -2;
    cast(miss, 'asha'); stepCompanions(miss);
    const contact = miss.companionState.slots.asha!.skill!.contactAt;
    hostile(miss).position.x = 6;
    while (miss.worldTick < contact) advance(miss, 1);
    expect(hostile(miss).reactionState).toBeUndefined();
    expect(miss.actors[1]!.position.x).toBeLessThan(0);
  });

  it('a wall or low ceiling stops the swept gesture and prevents an unearned contact', () => {
    for (const ceiling of [false, true]) {
      const state = engine('nyra'), ally = state.actors[1]!;
      ally.position.x = -2; state.skillReadyAt.heavy = 1000;
      cast(state, 'nyra'); stepCompanions(state);
      const contact = state.companionState.slots.nyra!.skill!.contactAt;
      state.arena.colliders = [{
        id: ceiling ? 'low-ceiling' : 'wall', kind: 'box',
        from: ceiling ? { x: -1, y: 2, z: 0 } : { x: -1.35, y: 1, z: 0 },
        halfExtents: ceiling ? { x: 3, y: .15, z: 3 } : { x: .08, y: 2, z: 3 },
        blocksMovement: true, blocksCamera: false,
      }];
      let maxX = ally.position.x, maxY = 0;
      while (state.worldTick < contact) {
        advance(state, 1); maxX = Math.max(maxX, ally.position.x); maxY = Math.max(maxY, ally.position.y);
      }
      if (ceiling) expect(maxY).toBeLessThanOrEqual(.25001);
      else expect(maxX + ally.radius).toBeLessThanOrEqual(-1.35 - .08 + 1e-6);
      expect(state.skillReadyAt.heavy).toBe(1000);
      expect(ally.position.y).toBe(0);
    }
  });

  it('Mending Seed locks its aim on release and does not heal after the target dodges it', () => {
    const state = engine('koro'); state.player.vitality = 40;
    cast(state, 'koro'); stepCompanions(state);
    const skill = state.companionState.slots.koro!.skill!;
    while (state.worldTick < skill.releaseAt) advance(state, 1);
    hostile(state).position.z = 2;
    while (state.worldTick < skill.contactAt) advance(state, 1);
    expect(state.player.vitality).toBe(40);
    expect(hostile(state).vitality).toBe(100);
  });
});

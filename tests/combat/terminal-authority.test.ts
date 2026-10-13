import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, makeActor, type CombatInput, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS, BOSS_ENCOUNTERS } from '../../src/game/combat/content.js';

const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
const idle: CombatInput = { tick: 0, move: v(), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
function lethalAttack(activeFrom: number): LiveHazard {
  const attack = ATTACKS['koro-vine-vault']!;
  return { ...structuredClone(attack.hazard), id: 'lethal-vault', attackId: attack.id, sourceId: 'koro', startTick: 0, activeFrom, activeUntil: activeFrom + 2, target: v(), origin: v(), direction: v(0, 0, -1), hitIds: [], threatTicks: [], cue: attack.cue, damage: 100, bounds: { min: v(-2, -1, -2), max: v(2, 3, 2) } };
}
function combat(activeFrom: number) {
  const state = createEngineState();
  state.arena.bounds = { min: v(-20, -2, -20), max: v(20, 20, 20) };
  state.actors.push(makeActor('koro', 'macaque', 'hostile', v(0, 0, -1), false, false, 100));
  state.actors[1]!.recoveringUntil = 10_000;
  state.targetId = 'koro'; state.encounter = BOSS_ENCOUNTERS['encounter-koro']!; state.encounterId = state.encounter.id;
  state.hazards = [lethalAttack(activeFrom)];
  return new CombatEngine(state);
}

describe('terminal player combat authority', () => {
  it('death before a Heavy hit cancels the actual pending impact and cannot subdue or reward the target', () => {
    const state = combat(4).snapshotState();
    state.actors[1]!.vitality = 10;
    const e = new CombatEngine(state);
    e.fixedStep({ ...idle, heavyPressed: true });
    expect(e.snapshotState().pendingImpact?.action).toBe('heavy');
    for (let t = 0; t < 100; t++) e.fixedStep({ ...idle, lightPressed: true, heavyPressed: true });
    expect(e.snapshot().player.vitality).toBe(0);
    expect(e.snapshot().actors.find(a => a.id === 'koro')?.vitality).toBe(10);
    expect(e.snapshot().actors.find(a => a.id === 'koro')?.downed).toBe(false);
    expect(e.consumeWorldEvents().some(event => event.type === 'encounter-resolved')).toBe(false);
    expect(e.snapshotState()).toMatchObject({ pendingImpact: undefined, bufferedAction: undefined, heavyChargeStartTick: null });
    expect(e.useAbility('ferocity', 'koro')).toBe(false);
  });
  it('retains a Heavy impact genuinely resolved before a later lethal hit, without postmortem follow-ups', () => {
    const e = combat(30); e.fixedStep({ ...idle, heavyPressed: true });
    for (let t = 0; t < 24; t++) e.fixedStep(idle);
    expect(e.snapshot().actors.find(a => a.id === 'koro')?.vitality).toBe(78);
    for (let t = 0; t < 100; t++) e.fixedStep({ ...idle, lightPressed: true });
    expect(e.snapshot().player.vitality).toBe(0);
    expect(e.snapshot().actors.find(a => a.id === 'koro')?.vitality).toBe(78);
  });
  it('clears a genuinely buffered follow-up when the player dies during recovery', () => {
    const e = combat(60); e.fixedStep({ ...idle, heavyPressed: true });
    // The connecting Heavy freezes the player clock, so wait for the actual last-8-ticks buffer window.
    for (let t = 0; t < 200 && e.snapshotState().actionRecoveryUntil - e.snapshotState().tick > 8; t++) e.fixedStep(idle);
    e.fixedStep({ ...idle, lightPressed: true });
    expect(e.snapshotState().bufferedAction?.action).toBe('light_1');
    for (let t = 0; t < 104; t++) e.fixedStep(idle);
    expect(e.snapshotState().bufferedAction).toBeUndefined();
    expect(e.snapshot().actors.find(a => a.id === 'koro')?.vitality).toBe(78);
  });
  it('clears an actual held Heavy charge on death and rejects its later release', () => {
    const e = combat(4); e.fixedStep({ ...idle, heavyPressed: true, heavyHeld: true });
    expect(e.snapshotState().heavyChargeStartTick).toBe(1);
    for (let t = 0; t < 5; t++) e.fixedStep(idle);
    expect(e.snapshotState().heavyChargeStartTick).toBeNull();
    e.fixedStep({ ...idle, heavyReleased: true, heavyHeldTicks: 100 });
    for (let t = 0; t < 100; t++) e.fixedStep(idle);
    expect(e.snapshot().actors.find(a => a.id === 'koro')?.vitality).toBe(100);
  });
  it('does not begin companion-targeted attacks or possession after the player is down', () => {
    const state = createEngineState(); state.player.vitality = 0;
    state.arena.bounds = { min: v(-20, -2, -20), max: v(20, 20, 20) };
    state.encounter = BOSS_ENCOUNTERS['encounter-orun']!; state.encounterId = state.encounter.id; state.phaseIndex = 2;
    state.actors.push(makeActor('orun', 'human', 'hostile', v(0, 0, -1), false, false, 100), makeActor('vara', 'hornbill', 'ally', v(1), false, true, 100));
    state.companionSlots = { scout: 'vara' };
    state.lastAttackTick = 120;
    const e = new CombatEngine(state);
    for (let t = 0; t < 100; t++) e.fixedStep(idle);
    expect(e.drainPresentationCues().filter(cue => cue.kind !== 'cancel')).toEqual([]);
    expect(e.snapshot().actors.find(a => a.id === 'vara')?.possessed).toBe(false);
    expect(e.consumeWorldEvents().some(event => event.type === 'possession')).toBe(false);
  });
  it('ends every already-scheduled target class on lethal damage, with death cancellation last', () => {
    const state = combat(4).snapshotState();
    state.actors.push(makeActor('vara', 'hornbill', 'ally', v(1), false, true, 100));
    const possession = ATTACKS['orun-crown-possession']!;
    state.hazards.push({ ...lethalAttack(5), ...structuredClone(possession.hazard), id: 'scheduled-possession', attackId: possession.id, sourceId: 'orun', targetActorId: 'vara', target: v(1), origin: v(1), activeFrom: 5, activeUntil: 20 });
    const e = new CombatEngine(state);
    let sawDeath = false;
    for (let t = 0; t < 104; t++) {
      e.fixedStep(idle); const cues = e.drainPresentationCues();
      const death = cues.find(cue => cue.kind === 'cancel' && 'cancellationReason' in cue && cue.cancellationReason === 'death');
      if (death) { expect(cues.at(-1)).toBe(death); sawDeath = true; }
      else if (sawDeath) expect(cues).toEqual([]);
    }
    expect(sawDeath).toBe(true);
    expect(e.snapshot().actors.find(a => a.id === 'vara')?.possessed).toBe(false);
    expect(e.consumeWorldEvents().some(event => event.type === 'possession')).toBe(false);
  });
});

it('announces an actual missed attack for its entire active interval without fabricating a hit', () => {
  const state = createEngineState(); state.arena.bounds = { min: v(-20, -2, -20), max: v(20, 20, 20) };
  state.actors.push(makeActor('koro', 'macaque', 'hostile', v(0, 0, -1), false, false, 100));
  const encounter = BOSS_ENCOUNTERS['encounter-koro']!;
  state.encounter = { ...encounter, phases: [{ ...encounter.phases[0]!, attackIds: ['koro-vine-vault'] }] }; state.encounterId = encounter.id;
  const e = new CombatEngine(state); e.fixedStep(idle);
  const hazard = e.snapshotState().hazards[0]!;
  e.drainPresentationCues();
  const active = [];
  for (let t = 0; t < 85; t++) {
    e.fixedStep({ ...idle, move: v(1) });
    active.push(...e.drainPresentationCues().filter(cue => cue.kind === 'active' && cue.scopeId === hazard.id));
  }
  expect(active).toHaveLength(1);
  expect(active[0]).toMatchObject({ phase: 'active', durationTicks: hazard.activeUntil - hazard.activeFrom, scopeId: hazard.id, position: hazard.target });
  expect(e.snapshot().player.vitality).toBe(100);
  expect(e.consumeEvents().some(event => event.kind === 'damage' && event.attackId === hazard.attackId)).toBe(false);
});

it('restores a surviving active hazard with a fresh remaining warning, not a replayed damage hit', () => {
  const e = combat(4);
  const state = e.snapshotState(); state.hazards[0]!.damage = 5; state.hazards[0]!.activeUntil = 15;
  e.restore(JSON.stringify(state));
  for (let tick = 0; tick < 4; tick++) e.fixedStep(idle);
  expect(e.snapshot().player.vitality).toBe(95);
  e.restore(e.serialize());
  expect(e.drainPresentationCues().some(cue => cue.kind === 'hit')).toBe(false);
  e.fixedStep(idle);
  const cues = e.drainPresentationCues();
  expect(cues.filter(cue => cue.kind === 'active')).toHaveLength(1);
  expect(cues.find(cue => cue.kind === 'active')).toMatchObject({ scopeId: 'lethal-vault', durationTicks: 10 });
  expect(cues.some(cue => cue.kind === 'hit')).toBe(false);
  expect(e.snapshot().player.vitality).toBe(95);
});

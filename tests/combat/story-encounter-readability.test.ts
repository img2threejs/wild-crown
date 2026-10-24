import { describe, expect, it } from 'bun:test';
import { CombatEngine, type CombatInput, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';

const idle: CombatInput = {
  tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false,
  heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false,
};
const live = (engine: CombatEngine) => (engine as unknown as { state: EngineState }).state;

describe('story placements render their authored model', () => {
  // The renderer hides any actor whose snapshot names a model other than the one loaded for it.
  it.each([
    ['greenwake', ['corrupted-boar', 'greenwake-sap-stalker', 'greenwake-root-rammer'], ['actor-ember-boar', 'actor-frost-sap-stalker', 'actor-root-rammer']],
    ['blood-bamboo-valley', ['hunter-melee-west', 'hunter-melee-east', 'hunter-ranged'], ['actor-camp-hunter-melee', 'actor-camp-hunter-melee', 'actor-camp-hunter-ranged']],
  ] as const)('%s variant placements keep their model through a region load', (regionId, ids, models) => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId, runId: 'models', presentActorIds: ids });
    const actors = engine.snapshot().actors;
    expect(ids.map(id => actors.find(actor => actor.id === id)?.renderVariantId)).toEqual([...models]);
  });

  it('default-model placements still use their species model', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'greenwake', runId: 'models', presentActorIds: ['yara'] });
    expect(engine.snapshot().actors.find(actor => actor.id === 'yara')?.renderVariantId).toBe('actor-yara');
  });
});

describe('boss phase step guidance', () => {
  function boarFight() {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'greenwake', runId: 'guidance', presentActorIds: ['corrupted-boar'] });
    engine.startEncounter({encounterId: 'greenwake-boar', regionId: 'greenwake', runId: 'guidance'});
    const boar = live(engine).actors.find(actor => actor.id === 'corrupted-boar')!;
    const drainTo = (ferocity: number) => { boar.ferocity = ferocity; engine.fixedStep(idle); };
    return { engine, drainTo, status: () => engine.snapshot().encounterStatus! };
  }

  it('follows the Greenwake boar from wear-down through the required tether to the cleanse', () => {
    const { engine, drainTo, status } = boarFight();
    expect(status()).toMatchObject({ title: 'charge lane', step: { action: 'wear-down', done: false } });

    drainTo(70);
    expect(status()).toMatchObject({ title: 'sap opening', step: { action: 'tether', done: false } });
    // Further damage alone cannot leave the phase: the tether is what the panel must keep asking for.
    drainTo(40);
    expect(status()).toMatchObject({ title: 'sap opening', step: { action: 'tether', done: false } });

    live(engine).phaseActionFlags.push('tether');
    expect(status().step).toEqual({ action: 'tether', done: true });
    drainTo(40);
    expect(status()).toMatchObject({ title: 'root pressure', step: { action: 'wear-down', done: false } });

    drainTo(20);
    expect(status()).toMatchObject({ title: 'cleanse window', step: { action: 'cleanse', done: false } });
    // One Cleanse that leaves corruption behind is not the end of the fight.
    live(engine).phaseActionFlags.push('cleanse');
    expect(status().step).toEqual({ action: 'cleanse', done: false });
  });

  it('never downs the Greenwake boar with damage before its cleanse, so the required tether keeps a target', () => {
    const { engine, status } = boarFight();
    const boar = live(engine).actors.find(actor => actor.id === 'corrupted-boar')!;
    // A heavy blow far beyond the remaining vitality and Ferocity while the fight still asks for the tether.
    boar.vitality = 5; boar.ferocity = 5;
    live(engine).pendingCompanionStrikes.push({ sourceId: 'vara' as never, targetId: boar.id, damage: 60, poise: 0, knockback: 0, dirX: 0, dirZ: 1, attackId: 'vara-storm-talon' });
    engine.fixedStep(idle);
    expect(boar.downed).toBe(false);
    expect(boar.vitality).toBe(1);
    expect(boar.allegiance).toBe('hostile');
    expect(live(engine).rewardEmitted).toBe(false);
    expect(status().title).toBe('sap opening');
  });

});

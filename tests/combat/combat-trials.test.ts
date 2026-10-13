import { describe, expect, it } from 'bun:test';
import { ASSET_PLAYTESTS, type AssetPlaytest } from '../../src/app/AssetPlaytests.js';
import { REGIONS } from '../../src/content/campaign.js';
import { CombatEngine, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { moveAerialCircle, moveCircle, vec } from '../../src/game/combat/geometry.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
function setup(playtest: AssetPlaytest): CombatEngine {
  const region = createCombatTrialRegion(REGIONS.find(region => region.id === playtest.regionId)!);
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: playtest.regionId, regionDefinition: region, runId: 'combat-gates', presentActorIds: playtest.trialSet.trials.map(trial => trial.monsterId) });
  engine.startEncounter({ encounterId: playtest.trialSet.encounterId, regionId: playtest.regionId, runId: 'combat-gates' });
  engine.enableCombatTrials();
  return engine;
}
function facingMonster(engine: CombatEngine, playtest: AssetPlaytest, vitality: number): CombatEngine {
  const seed = engine.snapshotState(), trial = playtest.trialSet.trials[seed.combatTrial!.index]!;
  const source = seed.actors.find(actor => actor.id === trial.monsterId)!;
  const player = seed.actors.find(actor => actor.id === seed.playerId)!;
  source.vitality = vitality;
  source.ferocity = 0; // Removing Black Sap alone must not substitute for this local victory.
  source.recoveringUntil = 100_000;
  player.position = vec(source.position.x, source.position.y, source.position.z + 1.6);
  player.facing = vec(0, 0, -1);
  player.velocity = vec(0, 0, 0);
  seed.player.vitality = seed.player.maxVitality = 10_000;
  seed.targetId = source.id;
  return new CombatEngine(seed);
}
function strike(engine: CombatEngine): void {
  engine.fixedStep({ ...idle, lightPressed: true });
  for (let tick = 0; tick < 60; tick++) engine.fixedStep(idle);
}

describe('monster victory and physical local stage gates', () => {
  for (const playtest of ASSET_PLAYTESTS) {
    it(`${playtest.id}: HP damage is visible but only a defeated current monster opens its own gate`, () => {
      let engine = setup(playtest);
      for (const [index, trial] of playtest.trialSet.trials.entries()) {
        engine = facingMonster(engine, playtest, 39);
        const maximum = engine.snapshotState().actors.find(actor => actor.id === trial.monsterId)!.maxVitality;
        strike(engine);
        const wounded = engine.snapshot().actors.find(actor => actor.id === trial.monsterId)!;
        expect(wounded.vitality).toBe(30);
        expect(wounded.downed).toBe(false);
        expect(engine.snapshot().encounterStatus!.monsters.find(monster => monster.id === trial.monsterId))
          .toMatchObject({ vitality: 30, maxVitality: maximum, active: true, cleared: false });
        expect(engine.snapshotState().combatTrial!.index).toBe(index);
        expect(engine.snapshot().trialGates!.map(gate => gate.open)).toEqual(playtest.trialSet.trials.map((_, gateIndex) => gateIndex < index));
        engine = facingMonster(engine, playtest, 4);
        strike(engine);
        expect(engine.snapshot().actors.find(actor => actor.id === trial.monsterId)).toMatchObject({ vitality: 0, downed: true, allegiance: 'neutral' });
        expect(engine.snapshotState().combatTrial!.index).toBe(index + 1);
        expect(engine.snapshot().trialGates!.map(gate => gate.open)).toEqual(playtest.trialSet.trials.map((_, gateIndex) => gateIndex <= index));
        expect(engine.snapshotState().arena.colliders.some(collider => collider.id === trial.gate.id)).toBe(false);
        for (const later of playtest.trialSet.trials.slice(index + 1)) expect(engine.snapshotState().arena.colliders.some(collider => collider.id === later.gate.id)).toBe(true);
      }
      expect(engine.snapshot().encounterStatus!.trial!.complete).toBe(true);
      expect(engine.consumeWorldEvents().some(event => event.type === 'encounter-resolved' || event.type === 'restoration' || event.type === 'fragment')).toBe(false);
      engine.resetToCheckpoint();
      expect(engine.snapshot().trialGates!.every(gate => !gate.open)).toBe(true);
      expect(engine.snapshot().encounterStatus!.trial).toMatchObject({ stage: 1, complete: false });
      for (const trial of playtest.trialSet.trials) {
        const actor = engine.snapshot().actors.find(actor => actor.id === trial.monsterId)!;
        expect(actor.vitality).toBe(actor.maxVitality!);
        expect(actor.downed).toBe(false);
      }
    });

    it(`${playtest.id}: time, movement and dodges do not qualify a living monster`, () => {
      const seed = facingMonster(setup(playtest), playtest, 100).snapshotState();
      seed.player.mana = seed.player.maxMana = 100_000;
      const engine = new CombatEngine(seed);
      for (let tick = 0; tick < 2400; tick++) {
        engine.fixedStep({ ...idle, move: vec(tick % 240 < 120 ? 1 : -1, 0, 0), dodgePressed: tick % 90 === 0 });
        engine.consumeEvents(); engine.drainPresentationCues();
      }
      expect(engine.snapshot().player.vitality).toBeGreaterThan(0);
      expect(engine.snapshotState().combatTrial!.index).toBe(0);
      expect(engine.snapshot().encounterStatus!.trial!.complete).toBe(false);
      expect(engine.snapshot().trialGates!.every(gate => !gate.open)).toBe(true);
    });
  }

  it('keeps closed gates solid for grounded and airborne routes', () => {
    const engine = setup(ASSET_PLAYTESTS[0]!);
    for (const gate of engine.snapshot().trialGates!) {
      const arena = engine.snapshotState().arena, center = gate.collider.from, acrossX = gate.collider.halfExtents!.x > 1;
      const start = vec(center.x - (acrossX ? 0 : 2), center.y, center.z - (acrossX ? 2 : 0));
      const delta = vec(acrossX ? 0 : 4, 0, acrossX ? 4 : 0);
      const end = moveCircle(arena, start, delta, .42, 1.6);
      expect(acrossX ? end.z : end.x).toBeLessThan(acrossX ? center.z : center.x);
      const air = moveAerialCircle(arena, { ...start, y: center.y - gate.collider.halfExtents!.y + .5 + 3.4 }, delta, .42, 1.6);
      expect(acrossX ? air.z : air.x).toBeLessThan(acrossX ? center.z : center.x);
    }
  });

  it('preserves partial HP and qualification through paused restore, then clears them on a new run', () => {
    const engine = facingMonster(setup(ASSET_PLAYTESTS[0]!), ASSET_PLAYTESTS[0]!, 39);
    strike(engine);
    engine.setTimePolicy('paused');
    const before = engine.snapshot(), restored = new CombatEngine();
    restored.restore(engine.serialize());
    for (let tick = 0; tick < 60; tick++) restored.fixedStep({ ...idle, lightPressed: true });
    expect(restored.snapshot().encounterStatus).toEqual(before.encounterStatus);
    expect(restored.snapshot().trialGates).toEqual(before.trialGates);
    expect(restored.snapshot().worldClock).toEqual(before.worldClock);
    restored.startNewRun('fresh');
    expect(restored.snapshot().trialGates).toBeUndefined();
    expect(restored.snapshotState().arena.colliders.some(collider => collider.id.startsWith('trial-gate:'))).toBe(false);
  });
});

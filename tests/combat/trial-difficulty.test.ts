import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { CombatEngine, type CombatInput, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { COMBAT_TRIAL_SETS, combatTrialSetFor } from '../../src/game/combat/CombatTrials.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { scaleTrialAttack, trialDifficulty, trialRamp } from '../../src/game/combat/TrialDifficulty.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { MONSTER_PROFILES, getWildlifePressure, scaleWildlifeAttack } from '../../src/game/combat/WildlifePressure.js';
import { vec } from '../../src/game/combat/geometry.js';
import type { RegionId } from '../../src/game/contracts.js';
import { rampedDamage } from './trial-ramp-helpers.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };

function trialEngine(regionId: RegionId, options: { index?: number; cursor?: number; player?: { x: number; z: number }; mutate?: (seed: EngineState) => void } = {}): CombatEngine {
  const set = combatTrialSetFor(regionId)!;
  const region = createCombatTrialRegion(REGIONS.find(candidate => candidate.id === regionId)!);
  const engine = new CombatEngine();
  engine.loadRegion({ regionId, regionDefinition: region, runId: 'trial-difficulty', presentActorIds: set.trials.map(trial => trial.monsterId) });
  engine.startEncounter({ encounterId: set.encounterId, regionId, runId: 'trial-difficulty' });
  engine.enableCombatTrials();
  const index = options.index ?? 0, trial = set.trials[index]!;
  const seed = engine.snapshotState();
  seed.combatTrial!.index = index;
  seed.player.vitality = seed.player.maxVitality = 1e6;
  const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z }, length = Math.hypot(toCenter.x, toCenter.z);
  const player = seed.actors.find(actor => actor.id === seed.playerId)!;
  player.position = options.player ? vec(options.player.x, trial.monsterPosition.y, options.player.z) : vec(trial.monsterPosition.x + toCenter.x / length * 5.5, trial.monsterPosition.y, trial.monsterPosition.z + toCenter.z / length * 5.5);
  if (options.cursor !== undefined) seed.wildlifeCombat = { engagedTicks: 0, sourceCursor: 0, attackCursors: { [trial.monsterId]: options.cursor } };
  options.mutate?.(seed);
  return new CombatEngine(seed);
}

describe('TrialDifficulty (pure ramp)', () => {
  it('raises difficulty across regular stages and across bosses while keeping each local boss stronger', () => {
    const ramp = ['greenwake', 'whispering-canopy', 'moonpine-ridge', 'mistveil-basin'].flatMap(regionId => [...trialRamp(regionId as RegionId, 3)]);
    for (const boss of [false, true]) {
      const stages = ramp.filter(stage => stage.boss === boss);
      for (let index = 1; index < stages.length; index++) {
        expect(stages[index]!.level).toBeGreaterThan(stages[index - 1]!.level);
        for (const key of ['vitality', 'damageScale', 'aggression', 'speedScale'] as const) expect(stages[index]![key]).toBeGreaterThanOrEqual(stages[index - 1]![key]);
      }
    }
    for (const mapStart of [0, 3, 6, 9]) {
      for (const key of ['vitality', 'damageScale', 'speedScale'] as const) expect(ramp[mapStart + 2]![key]).toBeGreaterThan(ramp[mapStart + 1]![key]);
      expect(ramp[mapStart + 2]!.aggression).toBeGreaterThanOrEqual(ramp[mapStart + 1]!.aggression);
    }
  });

  it('keeps aggression and speed inside their bounds and never slows a later stage', () => {
    const ramp = ['greenwake', 'whispering-canopy', 'moonpine-ridge', 'mistveil-basin'].flatMap(regionId => [...trialRamp(regionId as RegionId, 3)]);
    // Aggression capped at 1.18 (was an unbounded 1 + 0.03*level + 0.1 for boss) so late ranks never compress
    // windup so far that telegraphs disappear.
    const AGGRESSION_CEILING = 1.18;
    for (const stage of ramp) {
      expect(stage.aggression).toBeGreaterThanOrEqual(1);
      expect(stage.aggression).toBeLessThanOrEqual(AGGRESSION_CEILING + 1e-9);
      expect(stage.speedScale).toBeGreaterThanOrEqual(1);
      expect(stage.speedScale).toBeLessThanOrEqual(1 + 0.02 * 11 + 0.08 + 1e-9);
    }
  });

  it('scales rank pressure without applying the wildlife slowdown twice, preserving legible floors', () => {
    const base = { ...ATTACKS['viper-tail-lash']!, windupTicks: 80, commitTicks: 20, recoveryTicks: 60 };
    const neutral = scaleTrialAttack(base, 1);
    expect([neutral.windupTicks, neutral.commitTicks, neutral.recoveryTicks]).toEqual([80, 20, 60]);
    const quick = scaleTrialAttack(base, 2);
    expect([quick.windupTicks, quick.commitTicks, quick.recoveryTicks]).toEqual([40, 20, 30]);
    const floor = scaleTrialAttack({ ...base, windupTicks: 30, commitTicks: 2 }, 3);
    expect(floor.windupTicks).toBe(36);
    expect(floor.commitTicks).toBe(12);
    const pressured = scaleWildlifeAttack(base, getWildlifePressure(3000));
    const afterTrial = scaleTrialAttack(pressured, 1.2);
    expect(afterTrial.windupTicks).toBeGreaterThanOrEqual(36);
    expect(afterTrial.commitTicks).toBeGreaterThanOrEqual(12);
    expect(afterTrial.windupTicks).toBeLessThanOrEqual(pressured.windupTicks);
  });
});

describe('trial monster vitality', () => {
  for (const set of COMBAT_TRIAL_SETS) {
    it(`${set.regionId}: every stage's monster starts at the trial-difficulty vitality, in the engine state, the snapshot and the checkpoint`, () => {
      const engine = trialEngine(set.regionId);
      const ramp = trialRamp(set.regionId, set.trials.length);
      expect(set.trials.length).toBe(ramp.length);
      const state = engine.snapshotState();
      for (const [index, trial] of set.trials.entries()) {
        const expected = ramp[index]!.vitality;
        const actor = state.actors.find(candidate => candidate.id === trial.monsterId)!;
        expect([actor.vitality, actor.maxVitality]).toEqual([expected, expected]);
        const checkpointed = state.checkpoint!.actors.find(candidate => candidate.id === trial.monsterId)!;
        expect([checkpointed.vitality, checkpointed.maxVitality]).toEqual([expected, expected]);
        const listed = engine.snapshot().encounterStatus!.monsters[index]!;
        expect([listed.vitality, listed.maxVitality]).toEqual([expected, expected]);
      }
    });
  }

  it('checkpoint and retry restore the scaled HP of a wounded boss, and a paused restore keeps it', () => {
    const set = combatTrialSetFor('moonpine-ridge')!, boss = set.trials[2]!;
    const expected = trialRamp('moonpine-ridge', set.trials.length)[2]!.vitality;
    const engine = trialEngine('moonpine-ridge', {
      index: 2,
      mutate: seed => { const actor = seed.actors.find(candidate => candidate.id === boss.monsterId)!; actor.vitality = 37; },
    });
    expect(engine.snapshotState().actors.find(actor => actor.id === boss.monsterId)!.vitality).toBe(37);
    engine.resetToCheckpoint();
    const restored = engine.snapshotState().actors.find(actor => actor.id === boss.monsterId)!;
    expect([restored.vitality, restored.maxVitality]).toEqual([expected, expected]);
    const resumed = new CombatEngine(engine.snapshotState());
    expect(resumed.snapshotState().actors.find(actor => actor.id === boss.monsterId)!.maxVitality).toBe(expected);
  });
});

describe('trial snapshot boss flags', () => {
  for (const set of COMBAT_TRIAL_SETS) {
    it(`${set.regionId}: trial.boss / trial.level / monsters[].boss follow the stage`, () => {
      const ramp = trialRamp(set.regionId, set.trials.length);
      for (let index = 0; index < set.trials.length; index++) {
        const status = trialEngine(set.regionId, { index }).snapshot().encounterStatus!;
        expect(status.trial).toMatchObject({ boss: ramp[index]!.boss, level: ramp[index]!.level, stage: index + 1, totalStages: set.trials.length });
        expect(status.monsters.map(monster => monster.boss)).toEqual(ramp.map(stage => stage.boss));
      }
    });
  }

  it('flags only the final stage of a ranked map and of the Grove (Hollowheart at the Memory Pool)', () => {
    expect(trialEngine('greenwake', { index: 1 }).snapshot().encounterStatus!.trial!.boss).toBe(false);
    expect(trialEngine('greenwake', { index: 2 }).snapshot().encounterStatus!.trial!.boss).toBe(true);
    for (const [index, boss] of [[0, false], [1, false], [2, true]] as const) {
      const grove = trialEngine('the-grove', { index }).snapshot().encounterStatus!;
      expect(grove.trial!.boss).toBe(boss);
      expect(grove.monsters.map(monster => monster.boss)).toEqual([false, false, true]);
    }
  });
});

/** Steps until `monsterId` has a live hazard of `attackId` and returns that hazard together with every damage event the player takes from it. */
function castAndCollect(engine: CombatEngine, attackId: string, ticks: number) {
  const losses: number[] = [];
  let hazard: EngineState['hazards'][number] | undefined;
  for (let tick = 0; tick < ticks; tick++) {
    engine.fixedStep(idle);
    for (const event of engine.consumeEvents()) if (event.kind === 'damage' && event.attackId === attackId && event.actorId === 'aren') losses.push(event.damage!.amount);
    hazard ??= engine.snapshotState().hazards.find(candidate => candidate.attackId === attackId);
  }
  return { hazard: hazard!, losses };
}

describe('trial damage scaling on real casts', () => {
  it('scales a direct hit at hit time while the hazard keeps its authored damage', () => {
    const regionId = 'whispering-canopy', index = 2, set = combatTrialSetFor(regionId)!;
    const id = 'viper-tail-lash';
    const { hazard, losses } = castAndCollect(trialEngine(regionId, { index, cursor: set.trials[index]!.attackIds.indexOf(id) }), id, 400);
    const scale = trialDifficulty(regionId, index, set.trials.length).damageScale;
    expect(hazard.damage).toBe(ATTACKS[id]!.hazard.damage);
    expect(hazard.damageScale).toBeCloseTo(scale, 10);
    expect(losses.length).toBeGreaterThanOrEqual(1);
    expect(losses[0]).toBe(rampedDamage(regionId, index, set.trials.length, hazard.damage));
    expect(losses[0]).toBeGreaterThan(hazard.damage);
  });

  it('scales every poison pulse', () => {
    const regionId = 'whispering-canopy', index = 2, set = combatTrialSetFor(regionId)!;
    const id = 'viper-venom-spit';
    const { hazard, losses } = castAndCollect(trialEngine(regionId, { index, cursor: set.trials[index]!.attackIds.indexOf(id) }), id, 420);
    expect(hazard.damage).toBe(4);
    expect(losses.length).toBeGreaterThanOrEqual(5);
    for (const amount of losses) expect(amount).toBe(rampedDamage(regionId, index, set.trials.length, 4));
    expect(rampedDamage(regionId, index, set.trials.length, 4)).toBeGreaterThan(4);
  });

  it('leaves the first Greenwake stage and the Grove at authored damage', () => {
    for (const [regionId, attackId] of [['greenwake', 'boar-charge'], ['the-grove', combatTrialSetFor('the-grove')!.trials[0]!.attackIds[0]!]] as const) {
      const set = combatTrialSetFor(regionId)!;
      const { hazard, losses } = castAndCollect(trialEngine(regionId, { cursor: set.trials[0]!.attackIds.indexOf(attackId) }), attackId, 500);
      expect(hazard.damageScale ?? 1).toBe(1);
      expect(losses.length).toBeGreaterThanOrEqual(1);
      expect(losses[0]).toBe(hazard.damage);
    }
  });

  it('retains readable boss telegraphs and a recovery interval at the highest rank', () => {
    const regionId = 'mistveil-basin', index = 2, set = combatTrialSetFor(regionId)!;
    const id = set.trials[index]!.attackIds[0]!;
    const { hazard } = castAndCollect(trialEngine(regionId, { index, cursor: 0 }), id, 400);
    expect(hazard.recoveryUntil!).toBeGreaterThan(hazard.castUntil!);
    expect(hazard.windupUntil! - hazard.startTick).toBeGreaterThanOrEqual(36);
    expect(hazard.activeFrom - hazard.windupUntil!).toBeGreaterThanOrEqual(12);
  });
});

describe('trial monster speed', () => {
  /** Fastest ground speed a monster reaches while closing on a player standing just inside its engage range. */
  function peakSpeed(regionId: RegionId, index: number): number {
    const set = combatTrialSetFor(regionId)!, trial = set.trials[index]!;
    const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z }, length = Math.hypot(toCenter.x, toCenter.z);
    const engine = trialEngine(regionId, { index, player: { x: trial.monsterPosition.x + toCenter.x / length * 13, z: trial.monsterPosition.z + toCenter.z / length * 13 } });
    let peak = 0;
    for (let tick = 0; tick < 300; tick++) {
      engine.fixedStep(idle);
      const velocity = engine.snapshot().actors.find(actor => actor.id === trial.monsterId)!.velocity;
      // Lunges and charges are attack motion, not locomotion: only count ticks with no live cast.
      if (engine.snapshotState().hazards.length === 0) peak = Math.max(peak, Math.hypot(velocity.x, velocity.z));
    }
    return peak;
  }

  it('raises a boss advance speed past its authored value, within speedScale', () => {
    const regionId = 'whispering-canopy', index = 2, set = combatTrialSetFor(regionId)!, trial = set.trials[index]!;
    const authored = MONSTER_PROFILES[trial.monsterId]!, scale = trialDifficulty(regionId, index, set.trials.length).speedScale;
    const peak = peakSpeed(regionId, index);
    expect(peak).toBeGreaterThan(authored.advanceSpeed + 1e-6);
    expect(peak).toBeLessThanOrEqual(authored.advanceSpeed * scale + 1e-6);
  });

  it('keeps the first Greenwake stage at its authored speed', () => {
    const trial = combatTrialSetFor('greenwake')!.trials[0]!, authored = MONSTER_PROFILES[trial.monsterId]!;
    const peak = peakSpeed('greenwake', 0);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(authored.advanceSpeed + 1e-6);
  });
});

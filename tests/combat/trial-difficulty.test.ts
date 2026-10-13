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
import { rampedDamage, rampedTiming } from './trial-ramp-helpers.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };

/** Authored vitality per stage, from the contract table; the Grove is exempt. */
const HP_TABLE: Readonly<Record<string, readonly number[]>> = {
  greenwake: [100, 115, 286],
  'whispering-canopy': [145, 160, 385],
  'moonpine-ridge': [190, 205, 484],
  'mistveil-basin': [235, 250, 583],
  'the-grove': [100],
};

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
  it('follows the contract formulas for every stage of every ranked map', () => {
    const ranks: Record<string, number> = { greenwake: 0, 'whispering-canopy': 1, 'moonpine-ridge': 2, 'mistveil-basin': 3 };
    for (const [regionId, rank] of Object.entries(ranks)) {
      for (let stage = 0; stage < 3; stage++) {
        const level = rank * 3 + stage, boss = stage === 2, got = trialDifficulty(regionId as RegionId, stage, 3);
        expect(got.level).toBe(level);
        expect(got.boss).toBe(boss);
        expect(got.vitality).toBe(HP_TABLE[regionId]![stage]!);
        expect(got.damageScale).toBeCloseTo((1 + 0.05 * level) * (boss ? 1.35 : 1), 10);
        expect(got.aggression).toBeCloseTo(1 + 0.03 * level + (boss ? 0.1 : 0), 10);
        expect(got.speedScale).toBeCloseTo(1 + 0.02 * level + (boss ? 0.08 : 0), 10);
      }
    }
  });

  it('exempts the Grove: level 0, no boss, unit scales and 100 vitality', () => {
    expect(trialDifficulty('the-grove', 0, 1)).toEqual({ level: 0, boss: false, vitality: 100, damageScale: 1, aggression: 1, speedScale: 1 });
    expect(trialRamp('the-grove', 1)).toEqual([trialDifficulty('the-grove', 0, 1)]);
  });

  it('keeps aggression and speed inside their bounds and never slows a later stage', () => {
    const ramp = ['greenwake', 'whispering-canopy', 'moonpine-ridge', 'mistveil-basin'].flatMap(regionId => [...trialRamp(regionId as RegionId, 3)]);
    for (const stage of ramp) {
      expect(stage.aggression).toBeGreaterThanOrEqual(1);
      expect(stage.aggression).toBeLessThanOrEqual(1 + 0.03 * 11 + 0.1 + 1e-9);
      expect(stage.speedScale).toBeGreaterThanOrEqual(1);
      expect(stage.speedScale).toBeLessThanOrEqual(1 + 0.02 * 11 + 0.08 + 1e-9);
    }
    const levels = ramp.map(stage => stage.level);
    expect(levels).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // A boss is stricter than the stage before it on every axis.
    for (const mapStart of [0, 3, 6, 9]) for (const key of ['vitality', 'damageScale', 'aggression', 'speedScale'] as const) expect(ramp[mapStart + 2]![key]).toBeGreaterThan(ramp[mapStart + 1]![key]);
  });

  it('tightens windup and recovery by 1/aggression, keeping the 24-tick windup and 8-tick commit floors', () => {
    const base = ATTACKS['viper-tail-lash']!;
    expect(scaleTrialAttack(base, 1)).toBe(base);
    const quick = scaleTrialAttack(base, 1.43);
    expect(quick.windupTicks).toBe(Math.max(24, Math.round(base.windupTicks / 1.43)));
    expect(quick.recoveryTicks).toBe(Math.round(base.recoveryTicks / 1.43));
    expect(quick.commitTicks).toBe(base.commitTicks);
    expect(quick.activeTicks).toBe(base.activeTicks);
    const floor = scaleTrialAttack({ ...base, windupTicks: 30, commitTicks: 2 }, 3);
    expect(floor.windupTicks).toBe(24);
    expect(floor.commitTicks).toBe(8);
    // It composes after the existing pressure scaling.
    const pressured = scaleWildlifeAttack(base, getWildlifePressure(3000));
    expect(scaleTrialAttack(pressured, 1.2).windupTicks).toBeLessThanOrEqual(pressured.windupTicks);
    expect(scaleTrialAttack(pressured, 1.2).windupTicks).toBeGreaterThanOrEqual(24);
  });
});

describe('trial monster vitality', () => {
  for (const set of COMBAT_TRIAL_SETS) {
    it(`${set.regionId}: every stage's monster starts at the table HP, in the engine state, the snapshot and the checkpoint`, () => {
      const engine = trialEngine(set.regionId);
      const expected = HP_TABLE[set.regionId]!;
      expect(set.trials.length).toBe(expected.length);
      const state = engine.snapshotState();
      for (const [index, trial] of set.trials.entries()) {
        const actor = state.actors.find(candidate => candidate.id === trial.monsterId)!;
        expect([actor.vitality, actor.maxVitality]).toEqual([expected[index], expected[index]]);
        const checkpointed = state.checkpoint!.actors.find(candidate => candidate.id === trial.monsterId)!;
        expect([checkpointed.vitality, checkpointed.maxVitality]).toEqual([expected[index], expected[index]]);
        const listed = engine.snapshot().encounterStatus!.monsters[index]!;
        expect([listed.vitality, listed.maxVitality]).toEqual([expected[index], expected[index]]);
      }
    });
  }

  it('checkpoint and retry restore the scaled HP of a wounded boss, and a paused restore keeps it', () => {
    const set = combatTrialSetFor('moonpine-ridge')!, boss = set.trials[2]!;
    const engine = trialEngine('moonpine-ridge', {
      index: 2,
      mutate: seed => { const actor = seed.actors.find(candidate => candidate.id === boss.monsterId)!; actor.vitality = 37; },
    });
    expect(engine.snapshotState().actors.find(actor => actor.id === boss.monsterId)!.vitality).toBe(37);
    engine.resetToCheckpoint();
    const restored = engine.snapshotState().actors.find(actor => actor.id === boss.monsterId)!;
    expect([restored.vitality, restored.maxVitality]).toEqual([484, 484]);
    const resumed = new CombatEngine(engine.snapshotState());
    expect(resumed.snapshotState().actors.find(actor => actor.id === boss.monsterId)!.maxVitality).toBe(484);
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

  it('flags only the final stage of a ranked map and nothing in the Grove', () => {
    expect(trialEngine('greenwake', { index: 1 }).snapshot().encounterStatus!.trial!.boss).toBe(false);
    expect(trialEngine('greenwake', { index: 2 }).snapshot().encounterStatus!.trial!.boss).toBe(true);
    const grove = trialEngine('the-grove').snapshot().encounterStatus!;
    expect(grove.trial!.boss).toBe(false);
    expect(grove.monsters.every(monster => monster.boss === false)).toBe(true);
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

  it('shortens the live windup and recovery of boss casts exactly by the ramp', () => {
    const regionId = 'mistveil-basin', index = 2, set = combatTrialSetFor(regionId)!;
    const id = set.trials[index]!.attackIds[0]!;
    const { hazard } = castAndCollect(trialEngine(regionId, { index, cursor: 0 }), id, 400);
    const authored = ATTACKS[id]!;
    const [windup, commit, , recovery] = rampedTiming(regionId, index, set.trials.length, [authored.windupTicks, authored.commitTicks, authored.activeTicks, authored.recoveryTicks]);
    expect(hazard.windupUntil! - hazard.startTick).toBe(windup);
    expect(hazard.windupUntil! - hazard.startTick).toBeGreaterThanOrEqual(24);
    expect(hazard.windupUntil! - hazard.startTick).toBeLessThan(authored.windupTicks);
    expect(hazard.activeFrom - hazard.windupUntil!).toBe(commit);
    expect(hazard.recoveryUntil! - hazard.castUntil!).toBe(recovery);
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

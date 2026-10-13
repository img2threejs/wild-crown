import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, type CombatInput, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { GREENWAKE_COMBAT_TRIALS } from '../../src/game/combat/CombatTrials.js';
import { ATTACK_TURN_RATE_MAX, MONSTER_PROFILES, wrapAngle } from '../../src/game/combat/WildlifePressure.js';
import { vec } from '../../src/game/combat/geometry.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const DT = 1 / 60;

function trialEngine(index: number): CombatEngine {
  const engine = new CombatEngine();
  engine.startEncounter({ encounterId: 'greenwake-boar', regionId: 'greenwake', runId: 'monster-facing' });
  engine.enableCombatTrials();
  const seed = engine.snapshotState();
  const trial = GREENWAKE_COMBAT_TRIALS[index]!;
  seed.arena = createEngineState().arena;
  seed.arena.bounds = { min: vec(-200, -1, -200), max: vec(200, 12, 200) };
  seed.arena.colliders = [];
  seed.combatTrial!.index = index;
  seed.player.vitality = seed.player.maxVitality = 1e6;
  const player = seed.actors.find(actor => actor.id === 'aren')!;
  const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z };
  const length = Math.hypot(toCenter.x, toCenter.z);
  player.position = vec(trial.monsterPosition.x + toCenter.x / length * 5.5, 0, trial.monsterPosition.z + toCenter.z / length * 5.5);
  return new CombatEngine(seed);
}

const yawOf = (facing: { x: number; z: number }) => Math.atan2(facing.x, facing.z);

/**
 * Runs a trial until its monster starts an attack, optionally swings the monster's body `offset` rad away from the committed direction right
 * after the cast (the worst case a long attack lead-in could present), then records the facing of every tick until the cast window closes.
 */
function recordAttack(index: number, offset: number) {
  let engine = trialEngine(index);
  const monsterId = GREENWAKE_COMBAT_TRIALS[index]!.monsterId;
  let hazard: LiveHazard | undefined;
  for (let tick = 0; tick < 1500 && !hazard; tick++) {
    engine.fixedStep(idle);
    hazard = engine.snapshotState().hazards.find(candidate => candidate.sourceId === monsterId);
  }
  expect(hazard).toBeDefined();
  if (offset !== 0) {
    const seed = engine.snapshotState();
    const actor = seed.actors.find(candidate => candidate.id === monsterId)!;
    const angle = Math.atan2(hazard!.direction.x, hazard!.direction.z) + offset;
    actor.facing = vec(Math.sin(angle), 0, Math.cos(angle));
    engine = new CombatEngine(seed);
  }
  const samples: { tick: number; yaw: number; phase: string | undefined }[] = [];
  const read = () => {
    const monster = engine.snapshot().actors.find(candidate => candidate.id === monsterId)!;
    samples.push({ tick: engine.snapshotState().worldTick, yaw: yawOf(monster.facing), phase: monster.attackPhase });
  };
  read();
  while (engine.snapshotState().worldTick <= hazard!.castUntil!) { engine.fixedStep(idle); read(); }
  return { hazard: hazard!, samples, direction: yawOf(hazard!.direction) };
}

describe('monster attack facing', () => {
  for (let index = 0; index < GREENWAKE_COMBAT_TRIALS.length; index++) {
    const trial = GREENWAKE_COMBAT_TRIALS[index]!;
    for (const offset of [0, 0.4, -1.2, 2.6]) {
      it(`${trial.title}: turns at a bounded rate and is aligned on the first active tick (initial error ${offset} rad)`, () => {
        const { hazard, samples, direction } = recordAttack(index, offset);
        const profile = MONSTER_PROFILES[trial.monsterId]!;
        const limit = Math.min(ATTACK_TURN_RATE_MAX, Math.max(profile.yawRate, ATTACK_TURN_RATE_MAX)) * DT + 1e-9;
        let largestStep = 0;
        for (let i = 1; i < samples.length; i++) {
          if (samples[i]!.tick > hazard.activeFrom) break;
          largestStep = Math.max(largestStep, Math.abs(wrapAngle(samples[i]!.yaw - samples[i - 1]!.yaw)));
        }
        expect(largestStep).toBeLessThanOrEqual(limit);
        // No instant swing at the windup→commit boundary.
        const atCommit = samples.findIndex(sample => sample.tick === hazard.windupUntil! + 1);
        if (atCommit > 0) expect(Math.abs(wrapAngle(samples[atCommit]!.yaw - samples[atCommit - 1]!.yaw))).toBeLessThanOrEqual(limit);
        const atActive = samples.find(sample => sample.tick === hazard.activeFrom)!;
        expect(Math.abs(wrapAngle(atActive.yaw - direction))).toBeLessThan(1e-6);
        // The committed direction itself (hazard geometry) never changes.
        for (const sample of samples.filter(candidate => candidate.tick >= hazard.activeFrom && candidate.tick < hazard.castUntil!)) expect(Math.abs(wrapAngle(sample.yaw - direction))).toBeLessThan(1e-6);
      });
    }
  }

  it('keeps the hazard geometry and lunge direction fixed at cast time regardless of the body turn', () => {
    const aligned = recordAttack(0, 0).hazard, swung = recordAttack(0, 2.6).hazard;
    expect(swung.direction).toEqual(aligned.direction);
    expect(swung.origin).toEqual(aligned.origin);
    expect(swung.activeFrom).toBe(aligned.activeFrom);
    expect(swung.castUntil).toBe(aligned.castUntil);
  });
});

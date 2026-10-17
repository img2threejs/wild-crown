import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { CombatEngine, type CombatEvent, type CombatInput, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { combatTrialSetFor } from '../../src/game/combat/CombatTrials.js';
import { GROVE_ATTACKS, GROVE_COMBAT_TRIALS, GROVE_MONSTER_PROFILES, GROVE_TRIAL_SET } from '../../src/game/combat/GroveContent.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { TRIAL_BASE_VITALITY, trialDifficulty, trialRamp } from '../../src/game/combat/TrialDifficulty.js';
import { MONSTER_PROFILES, ROAR_TICKS } from '../../src/game/combat/WildlifePressure.js';
import { vec } from '../../src/game/combat/geometry.js';
import type { RegionDefinition, Vec3 } from '../../src/game/contracts.js';
import { rampedDamage } from './trial-ramp-helpers.js';

const region: RegionDefinition = createCombatTrialRegion(REGIONS.find(candidate => candidate.id === 'the-grove')!);
const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const BLIGHTED = GROVE_COMBAT_TRIALS[1]!, GUARDIAN = GROVE_COMBAT_TRIALS[2]!;

/** The Grove variant at stage `index` (earlier stages are skipped the way the difficulty tests do), Aren effectively unkillable, standing `range` m in front of the monster. */
function stageEngine(index: number, options: { range?: number; player?: Vec3; cursor?: number; mutate?: (seed: EngineState) => void } = {}): CombatEngine {
  const trial = GROVE_COMBAT_TRIALS[index]!;
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'grove-defence', presentActorIds: region.entities.map(entity => entity.id) });
  engine.startEncounter({ encounterId: 'grove-defence', regionId: 'the-grove', runId: 'grove-defence' });
  engine.enableCombatTrials();
  const seed = engine.snapshotState();
  seed.combatTrial!.index = index;
  seed.player.vitality = seed.player.maxVitality = 1e6;
  seed.arena.cameraBasis = { forward: vec(0, 0, 1), right: vec(1, 0, 0) };
  const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z }, length = Math.hypot(toCenter.x, toCenter.z);
  const range = options.range ?? 5.5;
  seed.actors.find(actor => actor.id === 'aren')!.position = options.player ?? vec(trial.monsterPosition.x + toCenter.x / length * range, 0, trial.monsterPosition.z + toCenter.z / length * range);
  if (options.cursor !== undefined) seed.wildlifeCombat = { engagedTicks: 0, sourceCursor: 0, attackCursors: { [trial.monsterId]: options.cursor } };
  options.mutate?.(seed);
  return new CombatEngine(seed);
}
const actorOf = (engine: CombatEngine, id: string) => engine.snapshot().actors.find(actor => actor.id === id)!;
const castCues = (events: readonly CombatEvent[], attackId: string) => events.filter(event => event.kind === 'cue' && event.attackId === attackId);

function probeCast(index: number, attackId: string) {
  const trial = GROVE_COMBAT_TRIALS[index]!;
  const engine = stageEngine(index, { cursor: trial.attackIds.indexOf(attackId) });
  for (let tick = 0; tick < 900; tick++) {
    engine.fixedStep(idle);
    if (castCues(engine.consumeEvents(), attackId).length) {
      const state = engine.snapshotState();
      return { engine, state, hazard: state.hazards.find(hazard => hazard.attackId === attackId)!, monster: state.actors.find(actor => actor.id === trial.monsterId)! };
    }
  }
  throw new Error('no ' + attackId + ' cast');
}

describe('grove three-stage journey', () => {
  it('is a three-stage trial set: Heartroot Practice, Black Sap Incursion and The Memory Pool, in that order', () => {
    expect(GROVE_TRIAL_SET.trials).toHaveLength(3);
    expect(GROVE_COMBAT_TRIALS.map(trial => [trial.id, trial.title, trial.monsterId, trial.monsterAssetId])).toEqual([
      ['evasion-practice', 'Heartroot Practice', 'grove-sprig', 'actor-grove-rootling'],
      ['sap-incursion', 'Black Sap Incursion', 'grove-blighted', 'actor-grove-blighted-rootling'],
      ['memory-pool', 'The Memory Pool', 'grove-hollowheart', 'actor-grove-hollowheart'],
    ]);
    expect(GROVE_COMBAT_TRIALS.map(trial => trial.gate.id)).toEqual(['trial-gate:evasion-practice', 'trial-gate:sap-incursion', 'trial-gate:memory-pool']);
    expect(GROVE_COMBAT_TRIALS.map(trial => trial.arena.radius)).toEqual([8, 8, 11]);
    expect(GROVE_COMBAT_TRIALS.map(trial => trial.attackIds.length)).toEqual([3, 3, 4]);
    // Each monster owns its attacks, and the practice, hollow and pool sit further north in that order.
    for (const trial of GROVE_COMBAT_TRIALS) for (const id of trial.attackIds) expect(ATTACKS[id]!.bossId).toBe(trial.monsterId);
    expect(GROVE_COMBAT_TRIALS[0]!.monsterPosition.z).toBeGreaterThan(GROVE_COMBAT_TRIALS[1]!.monsterPosition.z);
    expect(GROVE_COMBAT_TRIALS[1]!.monsterPosition.z).toBeGreaterThan(GROVE_COMBAT_TRIALS[2]!.monsterPosition.z);
  });

  it('places every monster inside its arena and every arena inside a clearing of the walk-mesh, with a monster profile whose band fits the arena', () => {
    const surfaces = new Map(region.ground.surfaces.map(surface => [surface.id, surface.points]));
    const clearings = ['grove-trial-practice-ring', 'grove-trial-blight-hollow', 'grove-trial-memory-pool'];
    const inside = (polygon: readonly Vec3[], x: number, z: number) => {
      let hit = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i]!, b = polygon[j]!;
        if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) hit = !hit;
      }
      return hit;
    };
    GROVE_COMBAT_TRIALS.forEach((trial, index) => {
      const ring = surfaces.get(clearings[index]!)!;
      expect(dist(trial.monsterPosition, trial.arena.center)).toBeLessThanOrEqual(trial.arena.radius);
      for (let step = 0; step < 32; step++) {
        const angle = step / 32 * Math.PI * 2;
        expect(inside(ring, trial.arena.center.x + Math.cos(angle) * trial.arena.radius, trial.arena.center.z + Math.sin(angle) * trial.arena.radius), `${trial.id} arena point ${step}`).toBe(true);
      }
      const profile = GROVE_MONSTER_PROFILES[trial.monsterId]!;
      expect(MONSTER_PROFILES[trial.monsterId]).toBe(profile);
      expect(profile.bandMax).toBeLessThanOrEqual(trial.arena.radius);
      expect(profile.bandMin).toBeLessThan(profile.bandMax);
    });
    // The guardian is the heaviest body with the widest band and the slowest turns.
    expect(GROVE_MONSTER_PROFILES['grove-hollowheart']!.radius).toBeGreaterThan(GROVE_MONSTER_PROFILES['grove-blighted']!.radius);
    expect(GROVE_MONSTER_PROFILES['grove-hollowheart']!.bandMax).toBeGreaterThan(GROVE_MONSTER_PROFILES['grove-blighted']!.bandMax);
    expect(GROVE_MONSTER_PROFILES['grove-hollowheart']!.yawRate).toBeLessThan(GROVE_MONSTER_PROFILES['grove-blighted']!.yawRate);
    expect(GROVE_MONSTER_PROFILES['grove-blighted']!.advanceSpeed).toBeGreaterThan(GROVE_MONSTER_PROFILES['grove-sprig']!.advanceSpeed);
  });
});

describe('grove trial difficulty: a gentle practice, a harder incursion and a boss', () => {
  it('names the three stage levels, flags only the final stage as the boss and leaves the practice at authored strength', () => {
    const ramp = trialRamp('the-grove', 3);
    expect(ramp.map(stage => [stage.level, stage.boss])).toEqual([[0, false], [1, false], [3, true]]);
    expect(ramp[0]).toMatchObject({ vitality: TRIAL_BASE_VITALITY, damageScale: 1, aggression: 1, speedScale: 1 });
    for (const key of ['vitality', 'damageScale', 'speedScale'] as const) {
      expect(ramp[1]![key]).toBeGreaterThan(ramp[0]![key]);
      expect(ramp[2]![key]).toBeGreaterThan(ramp[1]![key]);
    }
    expect(ramp[2]!.aggression).toBeGreaterThan(ramp[1]!.aggression);
    // Level 3 of the shared formula: a boss with 2.2x the health of a regular stage of its level.
    expect(ramp[2]!.vitality).toBe(Math.round(TRIAL_BASE_VITALITY * 1.45 * 2.2));
    expect(trialDifficulty('the-grove', 2, 3).damageScale).toBeCloseTo(1.15 * 1.35, 9);
    // Another region's ramp is untouched.
    expect(trialRamp('whispering-canopy', 3).map(stage => stage.level)).toEqual([3, 4, 5]);
  });

  it('seeds the three monsters with the ramped health and reports the boss flag in the encounter status', () => {
    const ramp = trialRamp('the-grove', 3);
    const engine = stageEngine(2);
    expect(GROVE_COMBAT_TRIALS.map(trial => actorOf(engine, trial.monsterId).maxVitality)).toEqual(ramp.map(stage => stage.vitality));
    expect(actorOf(engine, 'grove-hollowheart').large).toBeUndefined();
    const status = engine.snapshot().encounterStatus!;
    expect(status.title).toBe('The Memory Pool');
    expect(status.trial).toMatchObject({ stage: 3, totalStages: 3, boss: true, level: 3, complete: false });
    expect(status.monsters.map(monster => monster.boss)).toEqual([false, false, true]);
    expect(status.monsters.map(monster => monster.name)).toEqual(['Heartroot Sprig', 'Blighted Rootling', 'Hollowheart, the Sapbound Guardian']);
    expect(status.monsters[2]!.skills).toHaveLength(4);
    expect(stageEngine(0).snapshot().encounterStatus!.trial).toMatchObject({ stage: 1, boss: false, level: 0 });
    expect(stageEngine(1).snapshot().encounterStatus!.trial).toMatchObject({ stage: 2, boss: false, level: 1 });
  });
});

interface ExpectedAttack {
  readonly monster: string; readonly kind: string; readonly width: number; readonly depth: number; readonly radius: number; readonly height: number; readonly damage: number;
  readonly timing: readonly [number, number, number, number]; readonly lane?: boolean; readonly lunge?: { readonly kind: 'step'; readonly meters: number };
  readonly push?: number; readonly slow?: { readonly slowFactor: number; readonly slowTicks: number };
}
/** The contract (docs/features/grove-playtest.md): attack id -> shape, timing and movement of stages 2 and 3. */
const CONTRACT: Readonly<Record<string, ExpectedAttack>> = {
  'blighted-seed-lob': { monster: 'grove-blighted', kind: 'strike', width: 1.9, depth: 1.9, radius: 1.9, height: 0.2, damage: 7, timing: [58, 14, 10, 50] },
  'blighted-ground-pulse': { monster: 'grove-blighted', kind: 'wave', width: 5.6, depth: 1.3, radius: 0, height: 0.18, damage: 8, timing: [56, 14, 14, 52] },
  'blighted-lash-sweep': { monster: 'grove-blighted', kind: 'sweep', width: 2.6, depth: 7, radius: 0, height: 0.8, damage: 9, timing: [58, 14, 12, 50], lane: true },
  'hollowheart-leap-smash': { monster: 'grove-hollowheart', kind: 'strike', width: 3.4, depth: 3.4, radius: 3, height: 0.3, damage: 14, timing: [72, 16, 10, 62], lunge: { kind: 'step', meters: 4 } },
  'hollowheart-antler-sweep': { monster: 'grove-hollowheart', kind: 'sweep', width: 2.8, depth: 7.5, radius: 0, height: 0.9, damage: 11, timing: [64, 14, 12, 54], lane: true, lunge: { kind: 'step', meters: 2 } },
  'hollowheart-ichor-hurl': { monster: 'grove-hollowheart', kind: 'strike', width: 2.4, depth: 2.4, radius: 2.2, height: 0.25, damage: 9, timing: [68, 14, 10, 56], slow: { slowFactor: 0.7, slowTicks: 80 } },
  'hollowheart-heartlight-burst': { monster: 'grove-hollowheart', kind: 'area', width: 7.4, depth: 7.4, radius: 0, height: 1.2, damage: 10, timing: [70, 15, 14, 58], push: 1.5 },
};

describe('grove stage 2 and 3 attack definitions', () => {
  it('registers exactly the three blighted and four guardian attacks next to the three sprig ones', () => {
    expect(Object.keys(GROVE_ATTACKS).sort()).toEqual([...Object.keys(CONTRACT), 'sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep'].sort());
    for (const id of Object.keys(CONTRACT)) expect(ATTACKS[id]).toBe(GROVE_ATTACKS[id]!);
  });

  it('never routes an attack through an obstacle word, an element or the player-only heartroot look', () => {
    for (const id of Object.keys(GROVE_ATTACKS)) {
      expect(id).not.toMatch(/root|sap|stomp|march|seismic|trample|thorn|charge/);
      expect(GROVE_ATTACKS[id]!.element).toBeUndefined();
      expect(GROVE_ATTACKS[id]!.cue.length).toBeGreaterThan(40);
    }
  });

  for (const [id, want] of Object.entries(CONTRACT)) {
    it(`${id} matches its contract shape, timing and movement`, () => {
      const attack = ATTACKS[id]!;
      expect(attack.bossId).toBe(want.monster);
      expect(attack.hazard).toMatchObject({ kind: want.kind, width: want.width, depth: want.depth, radius: want.radius, heightAboveGround: want.height, damage: want.damage });
      expect([attack.windupTicks, attack.commitTicks, attack.activeTicks, attack.recoveryTicks]).toEqual([...want.timing]);
      expect(attack.laneFromSource ?? false).toBe(want.lane ?? false);
      expect(attack.lunge).toEqual(want.lunge);
      expect(attack.onHit?.pushMeters).toBe(want.push);
      expect(attack.onHit?.slowFactor).toBe(want.slow?.slowFactor);
      expect(attack.onHit?.slowTicks).toBe(want.slow?.slowTicks);
      // Every telegraph reads: a windup well past the scaled floor and a stated counter in the cue.
      expect(attack.windupTicks).toBeGreaterThanOrEqual(56);
      expect(attack.cue).toMatch(/Aren|Sidestep|Step|Jump|Dive|Leave/);
    });
  }

  it('escalates damage from the sprig through the blighted rootling to the guardian', () => {
    const mean = (ids: readonly string[]) => ids.reduce((sum, id) => sum + ATTACKS[id]!.hazard.damage, 0) / ids.length;
    const sprig = mean(GROVE_COMBAT_TRIALS[0]!.attackIds), blighted = mean(BLIGHTED.attackIds), guardian = mean(GUARDIAN.attackIds);
    expect(blighted).toBeGreaterThan(sprig);
    expect(guardian).toBeGreaterThan(blighted);
    // After the ramp the guardian's heaviest blow stays well under a third of Aren's 120 vitality (a boss that can be read and learned).
    const worst = Math.max(...GUARDIAN.attackIds.map(id => rampedDamage('the-grove', 2, 3, ATTACKS[id]!.hazard.damage)));
    expect(worst).toBeGreaterThan(14);
    expect(worst).toBeLessThan(40);
  });
});

describe('grove stage 2 and 3 attacks at runtime', () => {
  for (const [id, want] of Object.entries(CONTRACT)) {
    const index = want.monster === 'grove-blighted' ? 1 : 2;
    it(`${id}: aims the live attack at the locked player position with readable, ramped phase boundaries`, () => {
      const { hazard, state } = probeCast(index, id);
      const ramp = trialDifficulty('the-grove', index, 3);
      expect(hazard.windupUntil! - hazard.startTick).toBeGreaterThanOrEqual(36);
      expect(hazard.activeFrom - hazard.windupUntil!).toBeGreaterThanOrEqual(12);
      expect(hazard.damageScale).toBeCloseTo(ramp.damageScale, 9);
      expect(hazard.recoveryUntil!).toBeGreaterThan(hazard.castUntil!);
      const player = state.actors.find(actor => actor.id === 'aren')!;
      if (want.lane) {
        expect(hazard.depth).toBeGreaterThanOrEqual(want.depth);
        expect(hazard.depth).toBeLessThanOrEqual(want.depth + 2);
        expect(dist(hazard.origin, hazard.target)).toBeCloseTo(hazard.depth / 2, 6);
      } else {
        expect(hazard.target.x).toBeCloseTo(player.position.x, 6);
        expect(hazard.target.z).toBeCloseTo(player.position.z, 6);
      }
    });
  }

  it('hits Aren for the ramped damage: 8 x 1.05 and 14 x 1.5525 rounded', () => {
    for (const [attackId, index, damage] of [['blighted-ground-pulse', 1, 8], ['hollowheart-leap-smash', 2, 14]] as const) {
      const trial = GROVE_COMBAT_TRIALS[index]!;
      const engine = stageEngine(index, { cursor: trial.attackIds.indexOf(attackId), mutate: seed => { seed.player.vitality = seed.player.maxVitality = 400; } });
      let hit: CombatEvent | undefined;
      for (let tick = 0; tick < 900 && !hit; tick++) {
        engine.fixedStep(idle);
        hit = engine.consumeEvents().find(event => event.kind === 'damage' && event.attackId === attackId);
      }
      expect(hit?.damage?.amount).toBe(rampedDamage('the-grove', index, 3, damage));
    }
  });

  it('never spawns combat obstacles for any of the seven attacks', () => {
    for (const [id, want] of Object.entries(CONTRACT)) {
      const { engine } = probeCast(want.monster === 'grove-blighted' ? 1 : 2, id);
      for (let tick = 0; tick < 360; tick++) { engine.fixedStep(idle); engine.consumeEvents(); engine.drainPresentationCues(); }
      expect(engine.snapshotState().combatObstacles, id).toEqual([]);
    }
  });

  it('leaps (the leap smash lunges toward Aren) but never lunges for the hurl or the burst', () => {
    const leap = probeCast(2, 'hollowheart-leap-smash');
    expect(leap.monster.motion?.lunge).toMatchObject({ kind: 'step' });
    expect(probeCast(2, 'hollowheart-ichor-hurl').monster.motion?.lunge).toBeUndefined();
    expect(probeCast(2, 'hollowheart-heartlight-burst').monster.motion?.lunge).toBeUndefined();
  });
});

describe('grove stage 2 and 3 monsters', () => {
  for (const [index, trial] of [[1, BLIGHTED], [2, GUARDIAN]] as const) {
    it(`${trial.monsterId}: stays inside its arena and cycles its authored roster in order`, () => {
      const engine = stageEngine(index);
      const casts: string[] = [];
      for (let tick = 0; tick < 4200; tick++) {
        engine.fixedStep(idle);
        for (const event of engine.consumeEvents()) if (event.kind === 'cue' && event.actorId === trial.monsterId && event.attackId) casts.push(event.attackId);
        engine.drainPresentationCues();
        const monster = actorOf(engine, trial.monsterId);
        expect(dist(monster.position, trial.arena.center)).toBeLessThanOrEqual(trial.arena.radius + 1e-6);
        expect(monster.position.y).toBe(trial.arena.center.y);
      }
      expect(casts.length).toBeGreaterThanOrEqual(2 * trial.attackIds.length);
      for (let at = 0; at < casts.length; at++) expect(casts[at]).toBe(trial.attackIds[at % trial.attackIds.length]!);
    });

    it(`${trial.monsterId}: roars on engage from beyond its band and once more when pressure escalates`, () => {
      const profile = MONSTER_PROFILES[trial.monsterId]!;
      const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z }, length = Math.hypot(toCenter.x, toCenter.z);
      const far = vec(trial.monsterPosition.x + toCenter.x / length * (profile.bandMax + 2), 0, trial.monsterPosition.z + toCenter.z / length * (profile.bandMax + 2));
      const engage = stageEngine(index, { player: far });
      let roars = 0, damage = 0;
      for (let tick = 0; tick < ROAR_TICKS - 2; tick++) {
        engage.fixedStep(idle);
        damage += engage.consumeEvents().filter(event => event.kind === 'damage').length;
        roars += engage.drainPresentationCues().filter(cue => cue.kind === 'roar-cone' && cue.actorId === trial.monsterId).length;
      }
      expect(roars).toBe(1);
      expect(damage).toBe(0);
      expect(actorOf(engage, trial.monsterId).attackPhase).toBeUndefined();

      // The escalation roar: the final stage's phase roar (the guardian's second voice) comes from the shared pressure tiers.
      const escalate = stageEngine(index, { mutate: seed => { seed.wildlifeCombat = { engagedTicks: 898, sourceCursor: 0, attackCursors: {} }; seed.actors.find(actor => actor.id === trial.monsterId)!.recoveringUntil = 1e6; } });
      const escalations = [];
      for (let tick = 0; tick < 200; tick++) {
        escalate.fixedStep(idle);
        escalations.push(...escalate.drainPresentationCues().filter(cue => cue.kind === 'roar-cone' && cue.actorId === trial.monsterId));
      }
      expect(escalations).toHaveLength(1);
    });
  }

  it('the guardian moves at its ramped boss speed: faster than its authored advance, within speedScale', () => {
    const profile = MONSTER_PROFILES['grove-hollowheart']!, scale = trialDifficulty('the-grove', 2, 3).speedScale;
    const toCenter = { x: GUARDIAN.arena.center.x - GUARDIAN.monsterPosition.x, z: GUARDIAN.arena.center.z - GUARDIAN.monsterPosition.z }, length = Math.hypot(toCenter.x, toCenter.z);
    const engine = stageEngine(2, { player: vec(GUARDIAN.monsterPosition.x + toCenter.x / length * 13, 0, GUARDIAN.monsterPosition.z + toCenter.z / length * 13) });
    let peak = 0;
    for (let tick = 0; tick < 300; tick++) {
      engine.fixedStep(idle);
      const velocity = actorOf(engine, 'grove-hollowheart').velocity;
      if (engine.snapshotState().hazards.length === 0) peak = Math.max(peak, Math.hypot(velocity.x, velocity.z));
    }
    expect(peak).toBeGreaterThan(profile.advanceSpeed + 1e-6);
    expect(peak).toBeLessThanOrEqual(profile.advanceSpeed * scale + 1e-6);
  });
});

describe('grove progression: each defeat opens its gate and the last one completes the sanctuary', () => {
  /** Marks the current stage's monster defeated the way the engine does when its health runs out. */
  function defeat(engine: CombatEngine, monsterId: string): CombatEngine {
    const seed = engine.snapshotState();
    const monster = seed.actors.find(actor => actor.id === monsterId)!;
    monster.vitality = 0;
    monster.downed = true;
    const next = new CombatEngine(seed);
    next.fixedStep(idle);
    return next;
  }

  it('clears the three stages in order: gates open one by one, defeated monsters turn neutral and the encounter reads Sanctuary defended', () => {
    let engine = stageEngine(0);
    const trialOf = () => engine.snapshot().encounterStatus!.trial!;
    const gatesOf = () => engine.snapshot().trialGates!.map(gate => gate.open);
    expect(gatesOf()).toEqual([false, false, false]);
    expect(trialOf()).toMatchObject({ stage: 1, status: 'approach', complete: false });
    for (const [index, trial] of GROVE_COMBAT_TRIALS.entries()) {
      engine = defeat(engine, trial.monsterId);
      expect(actorOf(engine, trial.monsterId).allegiance).toBe('neutral');
      expect(gatesOf()).toEqual(GROVE_COMBAT_TRIALS.map((_, gate) => gate <= index));
      if (index < 2) expect(trialOf()).toMatchObject({ stage: index + 2, status: 'open', complete: false, boss: index + 1 === 2 });
    }
    expect(trialOf()).toMatchObject({ status: 'complete', complete: true });
    expect(engine.snapshot().encounterStatus!.title).toBe('Sanctuary defended');
    expect(combatTrialSetFor('the-grove')!.clearedTitle).toBe('Sanctuary defended');
  });

  it('the player really can defeat the guardian: a light attack on a one-hit guardian downs it and completes the run', () => {
    let engine = stageEngine(2, { range: 1.7, mutate: seed => { seed.actors.find(actor => actor.id === 'grove-hollowheart')!.vitality = 1; } });
    // Let the guardian engage (target lock), then strike until it falls.
    let downed = false;
    for (let tick = 0; tick < 1200 && !downed; tick++) {
      engine.fixedStep({ ...idle, tick, lightPressed: tick % 20 === 0 });
      engine.consumeEvents(); engine.drainPresentationCues();
      downed = actorOf(engine, 'grove-hollowheart').downed;
    }
    expect(downed).toBe(true);
    expect(actorOf(engine, 'grove-hollowheart').vitality).toBe(0);
    engine.fixedStep(idle);
    expect(engine.snapshot().encounterStatus!.trial).toMatchObject({ complete: true, status: 'complete' });
    expect(engine.snapshot().trialGates!.map(gate => gate.open)[2]).toBe(true);
    engine = defeat(engine, 'grove-hollowheart');
  });
});

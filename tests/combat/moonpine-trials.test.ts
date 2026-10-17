import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { ACTORS } from '../../src/content/world.js';
import { ATTACKS, WILDLIFE_ENCOUNTERS } from '../../src/game/combat/content.js';
import { CombatEngine, type CombatEvent, type CombatInput, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { COMBAT_TRIAL_SETS, combatTrialSetFor } from '../../src/game/combat/CombatTrials.js';
import { MOONPINE_ACTORS, MOONPINE_ATTACKS, MOONPINE_COMBAT_TRIALS, MOONPINE_MONSTER_PROFILES, MOONPINE_OWNER_GLOW, MOONPINE_SOLID_PROFILES } from '../../src/game/combat/MoonpineContent.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { MONSTER_PROFILES, ROAR_TICKS } from '../../src/game/combat/WildlifePressure.js';
import { vec } from '../../src/game/combat/geometry.js';
import type { RegionDefinition, Vec3 } from '../../src/game/contracts.js';

const region: RegionDefinition = createCombatTrialRegion(REGIONS.find(candidate => candidate.id === 'moonpine-ridge')!);
const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

describe('Moonpine trial set', () => {
  it('selects the Moonpine set for the region, whose roster is exactly its trial monsters', () => {
    const set = combatTrialSetFor('moonpine-ridge')!;
    expect(set).toMatchObject({ encounterId: 'moonpine-trials', clearedTitle: 'Ridge trials cleared' });
    expect(set.trials).toBe(MOONPINE_COMBAT_TRIALS);
    expect(COMBAT_TRIAL_SETS).toContain(set);
    const encounter = WILDLIFE_ENCOUNTERS['moonpine-trials']!;
    expect(encounter.regionId).toBe('moonpine-ridge');
    expect(encounter.encounterFamily).toBe('wildlife');
    expect(encounter.actorIds).toEqual(['aren', 'moonpine-frostfang', 'moonpine-scout', 'moonpine-ruun']);
    expect(encounter.phases.map(phase => [phase.id, phase.attackIds])).toEqual(MOONPINE_COMBAT_TRIALS.map(trial => [trial.id, trial.attackIds]));
    expect(new Set(set.trials.map(trial => trial.gate.id)).size).toBe(3);
    for (const trial of set.trials) {
      expect(MONSTER_PROFILES[trial.monsterId]).toBeDefined();
      for (const id of trial.attackIds) expect(ATTACKS[id]!.bossId).toBe(trial.monsterId);
    }
  });


  it('registers three wolf actors, identity glows and solid profiles in the shared tables', () => {
    for (const trial of MOONPINE_COMBAT_TRIALS) {
      expect(ACTORS[trial.monsterId]).toMatchObject({ id: trial.monsterId, species: 'wolf', role: 'wild', allegiance: 'wild', combatRole: 'hostile', assetId: trial.monsterAssetId });
      expect(MOONPINE_ACTORS[trial.monsterId]).toBe(ACTORS[trial.monsterId]);
    }
    expect(MOONPINE_OWNER_GLOW).toEqual({ 'moonpine-frostfang': 'ice', 'moonpine-scout': 'wind', 'moonpine-ruun': 'sap' });
    expect(MOONPINE_SOLID_PROFILES).toEqual({ 'prop-buried-wolf-temple': 'solid', 'prop-temple-chain-anchor': 'solid', 'prop-snow-ridge-rock': 'solid' });
  });

  it('never gives a monster attack the heartroot element and keeps obstacle words out of every id except through deliberate ice', () => {
    expect(Object.keys(MOONPINE_ATTACKS)).toHaveLength(9);
    for (const [id, attack] of Object.entries(MOONPINE_ATTACKS)) {
      expect(ATTACKS[id]).toBe(attack);
      expect(attack.element).not.toBe('heartroot');
      expect(/root|sap|stomp|march|seismic|trample|thorn|charge/.test(id), id).toBe(false);
      expect(/^(frostfang|howl-scout|chained-ruun)-/.test(id), id).toBe(true);
    }
    expect(Object.values(MOONPINE_ATTACKS).filter(attack => attack.element === 'ice').map(attack => attack.id)).toEqual(['frostfang-frost-breath', 'chained-ruun-breaking-ice']);
  });
});

interface ExpectedAttack {
  readonly monster: string; readonly element?: string; readonly kind: string; readonly width: number; readonly depth: number; readonly radius: number;
  readonly height: number; readonly damage: number; readonly timing: readonly [number, number, number, number];
  readonly lunge?: { readonly kind: 'step' | 'charge'; readonly meters?: number }; readonly push?: number; readonly slow?: { readonly slowFactor: number; readonly slowTicks: number }; readonly lane?: boolean;
}
/** The contract (docs/features/moonpine-playtest.md): attack id -> shape, timing, element and movement. */
const CONTRACT: Readonly<Record<string, ExpectedAttack>> = {
  'frostfang-pack-rush': { monster: 'moonpine-frostfang', kind: 'sweep', width: 1.8, depth: 8, radius: 0, height: 0.9, damage: 14, timing: [54, 12, 18, 46], lunge: { kind: 'charge' }, lane: true },
  'frostfang-ice-bite': { monster: 'moonpine-frostfang', kind: 'sweep', width: 1.6, depth: 5.5, radius: 0, height: 0.7, damage: 13, timing: [40, 12, 8, 46], lunge: { kind: 'step', meters: 3 }, lane: true },
  'frostfang-frost-breath': { monster: 'moonpine-frostfang', element: 'ice', kind: 'cone', width: 6, depth: 7, radius: 0, height: 1, damage: 9, timing: [54, 12, 14, 50], slow: { slowFactor: 0.65, slowTicks: 90 } },
  'howl-scout-flank-pounce': { monster: 'moonpine-scout', kind: 'strike', width: 2.2, depth: 2.2, radius: 1.8, height: 0.3, damage: 13, timing: [48, 12, 9, 44], lunge: { kind: 'step', meters: 5 } },
  'howl-scout-claw-rake': { monster: 'moonpine-scout', kind: 'sweep', width: 2.8, depth: 4.4, radius: 0, height: 0.8, damage: 11, timing: [38, 12, 8, 42], lunge: { kind: 'step', meters: 2 }, lane: true },
  'howl-scout-low-howl': { monster: 'moonpine-scout', kind: 'wave', width: 6.5, depth: 1.4, radius: 0, height: 0.18, damage: 9, timing: [54, 15, 14, 48], push: 1 },
  'chained-ruun-chain-pounce': { monster: 'moonpine-ruun', kind: 'strike', width: 3.4, depth: 3.4, radius: 2.6, height: 0.3, damage: 18, timing: [66, 15, 10, 56], lunge: { kind: 'step', meters: 4 } },
  'chained-ruun-howl-shockwave': { monster: 'moonpine-ruun', kind: 'area', width: 6.6, depth: 6.6, radius: 0, height: 1.2, damage: 12, timing: [60, 15, 14, 54], push: 1.5 },
  'chained-ruun-breaking-ice': { monster: 'moonpine-ruun', element: 'ice', kind: 'wave', width: 8, depth: 1.6, radius: 0, height: 0.2, damage: 12, timing: [60, 15, 14, 52], slow: { slowFactor: 0.7, slowTicks: 80 } },
};

describe('moonpine attack definitions', () => {
  for (const [id, want] of Object.entries(CONTRACT)) {
    it(`${id} matches its contract shape, timing and movement`, () => {
      const attack = ATTACKS[id]!;
      expect(attack.bossId).toBe(want.monster);
      expect(attack.element).toBe(want.element);
      expect(attack.hazard).toMatchObject({ kind: want.kind, width: want.width, depth: want.depth, radius: want.radius, heightAboveGround: want.height, damage: want.damage });
      expect([attack.windupTicks, attack.commitTicks, attack.activeTicks, attack.recoveryTicks]).toEqual([...want.timing]);
      expect(attack.lunge).toEqual(want.lunge);
      expect(attack.onHit?.pushMeters).toBe(want.push);
      expect(attack.onHit?.slowFactor).toBe(want.slow?.slowFactor);
      expect(attack.onHit?.slowTicks).toBe(want.slow?.slowTicks);
      expect(attack.hitIntervalTicks).toBeUndefined();
      expect(attack.laneFromSource ?? false).toBe(want.lane ?? false);
      expect(attack.cue.length).toBeGreaterThan(20);
      expect(attack.cue).not.toMatch(/[^\x20-\x7e]/);
    });
  }
});

/** The real Moonpine variant loaded the way the playtest loads it, with an effectively unkillable Aren and world-space movement. */
function moonpineEngine(index: number, options: { player?: Vec3; cursor?: number; mutate?: (seed: EngineState) => void } = {}): CombatEngine {
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: 'moonpine-ridge', regionDefinition: region, runId: 'moonpine-trials', presentActorIds: region.entities.map(entity => entity.id) });
  engine.startEncounter({ encounterId: 'moonpine-trials', regionId: 'moonpine-ridge', runId: 'moonpine-trials' });
  engine.enableCombatTrials();
  const seed = engine.snapshotState();
  const trial = MOONPINE_COMBAT_TRIALS[index]!;
  seed.combatTrial!.index = index;
  seed.player.vitality = seed.player.maxVitality = 1e6;
  seed.arena.cameraBasis = { forward: vec(0, 0, 1), right: vec(1, 0, 0) };
  const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z }, length = Math.hypot(toCenter.x, toCenter.z);
  const player = seed.actors.find(actor => actor.id === 'aren')!;
  // Aren starts 5.5 m from the monster, towards the arena centre.
  player.position = options.player ?? vec(trial.monsterPosition.x + toCenter.x / length * 5.5, trial.monsterPosition.y, trial.monsterPosition.z + toCenter.z / length * 5.5);
  if (options.cursor !== undefined) seed.wildlifeCombat = { engagedTicks: 0, sourceCursor: 0, attackCursors: { [trial.monsterId]: options.cursor } };
  options.mutate?.(seed);
  return new CombatEngine(seed);
}
const monsterOf = (engine: CombatEngine, index: number) => engine.snapshot().actors.find(actor => actor.id === MOONPINE_COMBAT_TRIALS[index]!.monsterId)!;
const playerOf = (engine: CombatEngine) => engine.snapshot().actors.find(actor => actor.id === 'aren')!;
const castCues = (events: readonly CombatEvent[], attackId: string) => events.filter(event => event.kind === 'cue' && event.attackId === attackId);
const trialIndexOf = (monster: string) => MOONPINE_COMBAT_TRIALS.findIndex(trial => trial.monsterId === monster);

/** Steps until the monster begins `attackId`, as its first authored cast (the rotation cursor starts on it). */
function probeCast(index: number, attackId: string, player?: Vec3) {
  const trial = MOONPINE_COMBAT_TRIALS[index]!;
  const engine = moonpineEngine(index, { player, cursor: trial.attackIds.indexOf(attackId) });
  for (let tick = 0; tick < 600; tick++) {
    engine.fixedStep(idle);
    if (castCues(engine.consumeEvents(), attackId).length) {
      const state = engine.snapshotState();
      return { engine, state, hazard: state.hazards.find(hazard => hazard.attackId === attackId)!, monster: state.actors.find(actor => actor.id === trial.monsterId)! };
    }
  }
  throw new Error('no ' + attackId + ' cast');
}

describe('moonpine attacks at runtime', () => {
  for (const [id, want] of Object.entries(CONTRACT)) {
    const index = trialIndexOf(want.monster);
    it(`${id}: aims the live attack at the locked player position with readable phase boundaries`, () => {
      const { hazard, state } = probeCast(index, id);
      expect(hazard.windupUntil! - hazard.startTick).toBeGreaterThanOrEqual(36);
      expect(hazard.activeFrom - hazard.windupUntil!).toBeGreaterThanOrEqual(12);
      const player = state.actors.find(actor => actor.id === 'aren')!;
      if (want.lane) {
        // Lanes start at the caster and reach past the aimed position; they are centred half a lane ahead of the body.
        expect(hazard.depth).toBeGreaterThanOrEqual(want.depth);
        expect(hazard.depth).toBeLessThanOrEqual(want.depth + 2);
        expect(dist(hazard.origin, hazard.target)).toBeCloseTo(hazard.depth / 2, 6);
        expect(dist(hazard.origin, player.position)).toBeLessThanOrEqual(hazard.depth);
      } else if (want.kind !== 'cone') {
        // Everything else is locked onto where Aren stood when the cast began.
        expect(hazard.target.x).toBeCloseTo(player.position.x, 6);
        expect(hazard.target.z).toBeCloseTo(player.position.z, 6);
      }
    });
  }

  it('frostfang-pack-rush charges the whole lane during the active window', () => {
    const { engine, hazard, monster } = probeCast(0, 'frostfang-pack-rush');
    const lunge = monster.motion!.lunge!;
    expect(lunge.kind).toBe('charge');
    expect(lunge.fromTick).toBe(hazard.activeFrom);
    expect(lunge.toTick).toBe(hazard.castUntil!);
    expect(lunge.travel).toBeCloseTo(Math.max(2, hazard.depth - 1), 6);
    const start = monster.position;
    while (engine.snapshotState().worldTick < lunge.toTick) { engine.fixedStep(idle); engine.consumeEvents(); }
    expect(dist(monsterOf(engine, 0).position, start)).toBeGreaterThan(Math.min(lunge.travel, 3) * 0.8);
    expect(dist(monsterOf(engine, 0).position, start)).toBeLessThanOrEqual(lunge.travel + 0.05);
  });

  it('frostfang-ice-bite steps up to 3 m along its lane while the bite winds into its commit', () => {
    const { hazard, monster, state } = probeCast(0, 'frostfang-ice-bite', vec(-46 + 1, 0, -22 - 6));
    const lunge = monster.motion!.lunge;
    const player = state.actors.find(actor => actor.id === 'aren')!;
    const expected = Math.min(3, Math.max(0, dist(hazard.origin, player.position) - 3.5));
    if (expected > 0.05) {
      expect(lunge!.kind).toBe('step');
      expect(lunge!.travel).toBeCloseTo(expected, 6);
      expect(lunge!.toTick).toBe(hazard.activeFrom);
    } else expect(lunge).toBeUndefined();
  });

  it('howl-scout-flank-pounce lunges up to 5 m towards the committed point during the commit window only', () => {
    const { engine, hazard, monster, state } = probeCast(1, 'howl-scout-flank-pounce', vec(6 + 7, 0, -22 + 4));
    const lunge = monster.motion!.lunge!;
    expect(lunge.kind).toBe('step');
    expect(lunge.fromTick).toBe(hazard.windupUntil!);
    expect(lunge.toTick).toBe(hazard.activeFrom);
    const player = state.actors.find(actor => actor.id === 'aren')!;
    expect(lunge.travel).toBeCloseTo(Math.min(5, Math.max(0, dist(hazard.origin, player.position) - 3.5)), 6);
    expect(lunge.travel).toBeGreaterThan(0.5);
    const start = monster.position;
    while (engine.snapshotState().worldTick < lunge.fromTick) { engine.fixedStep(idle); engine.consumeEvents(); }
    expect(dist(monsterOf(engine, 1).position, start)).toBeLessThan(0.05);
    while (engine.snapshotState().worldTick < lunge.toTick) { engine.fixedStep(idle); engine.consumeEvents(); }
    expect(dist(monsterOf(engine, 1).position, start)).toBeGreaterThan(lunge.travel * 0.9);
    expect(dist(monsterOf(engine, 1).position, start)).toBeLessThanOrEqual(lunge.travel + 0.05);
  });

  it('chained-ruun-chain-pounce steps up to 4 m towards the committed point and lands a large disk', () => {
    const { hazard, monster, state } = probeCast(2, 'chained-ruun-chain-pounce', vec(49 - 8, 4, -22 + 4));
    const lunge = monster.motion!.lunge!;
    const player = state.actors.find(actor => actor.id === 'aren')!;
    expect(lunge.kind).toBe('step');
    expect(lunge.travel).toBeCloseTo(Math.min(4, Math.max(0, dist(hazard.origin, player.position) - 3.5)), 6);
    expect(hazard.radius).toBe(2.6);
    expect(hazard.radius * 2).toBeGreaterThan(5);
  });

  for (const [index, id, meters] of [[1, 'howl-scout-low-howl', 1], [2, 'chained-ruun-howl-shockwave', 1.5]] as const) {
    it(`${id} pushes Aren ${meters} m along its direction when it connects`, () => {
      const engine = moonpineEngine(index, { cursor: MOONPINE_COMBAT_TRIALS[index]!.attackIds.indexOf(id) });
      let before = playerOf(engine).position, pushed: number | undefined, alignment = 0;
      for (let tick = 0; tick < 700 && pushed === undefined; tick++) {
        before = playerOf(engine).position;
        engine.fixedStep(idle);
        const hit = engine.consumeEvents().find(event => event.kind === 'damage' && event.attackId === id);
        if (!hit) continue;
        const hazard = engine.snapshotState().hazards.find(candidate => candidate.attackId === id)!;
        // The push is an eased knockback: measure once the slide has settled.
        for (let settle = 0; settle < 90 && playerOf(engine).reaction; settle++) { engine.fixedStep(idle); engine.consumeEvents(); }
        const after = playerOf(engine).position;
        pushed = dist(before, after);
        alignment = ((after.x - before.x) * hazard.direction.x + (after.z - before.z) * hazard.direction.z) / (pushed || 1);
      }
      expect(pushed).toBeCloseTo(meters, 1);
      expect(alignment).toBeGreaterThan(0.99);
    });
  }

  for (const [index, id] of [[0, 'frostfang-frost-breath'], [2, 'chained-ruun-breaking-ice']] as const) {
    it(`${id} chills Aren on contact and raises ice pillars on the flanks of its landing mark`, () => {
      const want = CONTRACT[id]!;
      const engine = moonpineEngine(index, { cursor: MOONPINE_COMBAT_TRIALS[index]!.attackIds.indexOf(id) });
      let slowed: { factor: number; untilWorldTick: number } | undefined, hitTick = -1, ice = 0;
      for (let tick = 0; tick < 700 && slowed === undefined; tick++) {
        engine.fixedStep(idle);
        const events = engine.consumeEvents();
        ice = Math.max(ice, engine.snapshotState().combatObstacles.filter(obstacle => obstacle.attackId === id && obstacle.kind === 'ice').length);
        if (events.some(event => event.kind === 'damage' && event.attackId === id)) { slowed = engine.snapshotState().playerSlow ?? undefined; hitTick = engine.snapshotState().worldTick; }
      }
      expect(slowed).toBeDefined();
      expect(slowed!.factor).toBe(want.slow!.slowFactor);
      expect(slowed!.untilWorldTick - hitTick).toBe(want.slow!.slowTicks);
      for (let tick = 0; tick < 10 && ice === 0; tick++) { engine.fixedStep(idle); ice = engine.snapshotState().combatObstacles.filter(obstacle => obstacle.attackId === id).length; }
      expect(ice).toBeGreaterThan(0);
    });
  }

  it('only the two ice attacks raise obstacles; the other seven leave the arena clear', () => {
    for (const [index, trial] of MOONPINE_COMBAT_TRIALS.entries()) for (const id of trial.attackIds) {
      if (ATTACKS[id]!.element === 'ice') continue;
      const engine = moonpineEngine(index, { cursor: trial.attackIds.indexOf(id) });
      let active = false;
      for (let tick = 0; tick < 700 && !active; tick++) {
        engine.fixedStep(idle); engine.consumeEvents();
        const hazard = engine.snapshotState().hazards.find(candidate => candidate.attackId === id);
        if (hazard && engine.snapshotState().worldTick > hazard.activeFrom + 2) active = true;
        expect(engine.snapshotState().combatObstacles, id).toEqual([]);
      }
      expect(active, id).toBe(true);
    }
  });

  it('non-elemental moonpine attacks use the generic attack-keyed presentation cues, elemental ones carry their element', () => {
    for (const [index, id] of [[0, 'frostfang-pack-rush'], [0, 'frostfang-frost-breath'], [1, 'howl-scout-low-howl'], [2, 'chained-ruun-breaking-ice']] as const) {
      const engine = moonpineEngine(index, { cursor: MOONPINE_COMBAT_TRIALS[index]!.attackIds.indexOf(id) });
      const cues: { kind: string; attackId?: string; element?: string }[] = [];
      for (let tick = 0; tick < 500 && !cues.some(cue => cue.kind === 'active' && cue.attackId === id); tick++) {
        engine.fixedStep(idle); engine.consumeEvents();
        cues.push(...engine.drainPresentationCues());
      }
      const active = cues.find(cue => cue.kind === 'active' && cue.attackId === id)!;
      expect(active).toBeDefined();
      expect(active.element).toBe(CONTRACT[id]!.element);
      expect(cues.some(cue => cue.kind === 'anticipation' && cue.attackId === id)).toBe(true);
    }
  });
});

describe('moonpine trial monsters', () => {
  for (const [index, trial] of MOONPINE_COMBAT_TRIALS.entries()) {
    it(`${trial.title}: stays inside its arena and cycles its authored roster in order`, () => {
      const engine = moonpineEngine(index);
      const casts: string[] = [];
      for (let tick = 0; tick < 3600; tick++) {
        engine.fixedStep(idle);
        for (const event of engine.consumeEvents()) if (event.kind === 'cue' && event.actorId === trial.monsterId && event.attackId) casts.push(event.attackId);
        engine.drainPresentationCues();
        const monster = monsterOf(engine, index);
        expect(dist(monster.position, trial.arena.center)).toBeLessThanOrEqual(trial.arena.radius);
        expect(monster.position.y).toBe(trial.arena.center.y);
      }
      expect(casts.length).toBeGreaterThanOrEqual(6);
      const roster = [...trial.attackIds];
      expect(casts.slice(0, 6)).toEqual([...roster, ...roster]);
      for (let at = 0; at < casts.length; at++) expect(casts[at]).toBe(roster[at % roster.length]!);
    });

    it(`${trial.title}: roars on engage from beyond its band and once more when pressure escalates`, () => {
      const profile = MONSTER_PROFILES[trial.monsterId]!;
      const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z }, length = Math.hypot(toCenter.x, toCenter.z);
      const direction = { x: toCenter.x / length, z: toCenter.z / length };
      const far = (range: number) => vec(trial.monsterPosition.x + direction.x * range, trial.monsterPosition.y, trial.monsterPosition.z + direction.z * range);
      const engage = moonpineEngine(index, { player: far(profile.bandMax + 2) });
      let roars = 0, damage = 0;
      for (let tick = 0; tick < ROAR_TICKS - 2; tick++) {
        engage.fixedStep(idle);
        damage += engage.consumeEvents().filter(event => event.kind === 'damage').length;
        roars += engage.drainPresentationCues().filter(cue => cue.kind === 'roar-cone' && cue.actorId === trial.monsterId).length;
      }
      expect(roars).toBe(1);
      expect(damage).toBe(0);
      expect(monsterOf(engage, index).attackPhase).toBeUndefined();

      const escalate = new CombatEngine(moonpineEngine(index, { mutate: seed => { seed.wildlifeCombat = { engagedTicks: 898, sourceCursor: 0, attackCursors: {} }; seed.actors.find(actor => actor.id === trial.monsterId)!.recoveringUntil = 1e6; } }).snapshotState());
      const escalations = [];
      for (let tick = 0; tick < 200; tick++) {
        escalate.fixedStep(idle);
        escalations.push(...escalate.drainPresentationCues().filter(cue => cue.kind === 'roar-cone' && cue.actorId === trial.monsterId));
      }
      expect(escalations).toHaveLength(1);
    });
  }
});


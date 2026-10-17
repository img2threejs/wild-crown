import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { ATTACKS, WILDLIFE_ENCOUNTERS } from '../../src/game/combat/content.js';
import { CombatEngine, type CombatEvent, type CombatInput, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { CANOPY_COMBAT_TRIALS, COMBAT_TRIAL_SETS, GREENWAKE_COMBAT_TRIALS, combatTrialSetFor } from '../../src/game/combat/CombatTrials.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { MONSTER_PROFILES, ROAR_TICKS } from '../../src/game/combat/WildlifePressure.js';
import { vec } from '../../src/game/combat/geometry.js';
import type { RegionDefinition, Vec3 } from '../../src/game/contracts.js';
import { rampedDamage } from './trial-ramp-helpers.js';

const region: RegionDefinition = createCombatTrialRegion(REGIONS.find(candidate => candidate.id === 'whispering-canopy')!);
const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

describe('per-region combat-trial sets', () => {
  it('selects the set of the loaded region and nothing for other regions', () => {
    expect(combatTrialSetFor('greenwake')).toMatchObject({ encounterId: 'greenwake-boar', clearedTitle: 'Forest trials cleared' });
    expect(combatTrialSetFor('greenwake')!.trials).toBe(GREENWAKE_COMBAT_TRIALS);
    expect(combatTrialSetFor('whispering-canopy')).toMatchObject({ encounterId: 'canopy-trials', clearedTitle: 'Canopy trials cleared' });
    expect(combatTrialSetFor('whispering-canopy')!.trials).toBe(CANOPY_COMBAT_TRIALS);
    expect(combatTrialSetFor('blood-bamboo-valley')).toBeUndefined();
    // Every set names an authored wildlife encounter of its region whose roster is exactly its trial monsters.
    for (const set of COMBAT_TRIAL_SETS) {
      const encounter = WILDLIFE_ENCOUNTERS[set.encounterId]!;
      expect(encounter.regionId).toBe(set.regionId);
      expect(encounter.encounterFamily).toBe('wildlife');
      expect(encounter.actorIds.filter(id => id !== 'aren')).toEqual(set.trials.map(trial => trial.monsterId));
      expect(new Set(set.trials.map(trial => trial.gate.id)).size).toBe(set.trials.length);
      for (const trial of set.trials) {
        expect(MONSTER_PROFILES[trial.monsterId]).toBeDefined();
        for (const id of trial.attackIds) expect(ATTACKS[id]!.bossId).toBe(trial.monsterId);
      }
    }
  });


  it('refuses to enable trials outside a playtest region encounter', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'blood-bamboo-valley', runId: 'no-trials', presentActorIds: [] });
    expect(() => engine.enableCombatTrials()).toThrow();
    const canopy = new CombatEngine();
    canopy.loadRegion({ regionId: 'whispering-canopy', regionDefinition: region, runId: 'no-encounter', presentActorIds: [] });
    expect(() => canopy.enableCombatTrials()).toThrow();
  });
});

interface ExpectedAttack {
  readonly monster: string; readonly element?: string; readonly kind: string; readonly width: number; readonly depth: number; readonly radius: number;
  readonly height: number; readonly damage: number; readonly timing: readonly [number, number, number, number];
  readonly lunge?: { readonly kind: 'step' | 'charge'; readonly meters?: number }; readonly push?: number; readonly interval?: number; readonly cast?: number; readonly lane?: boolean;
}
/** The cross-team contract (docs/features/combat.md): attack id -> shape, timing, element and movement. */
const CONTRACT: Readonly<Record<string, ExpectedAttack>> = {
  'howler-rock-hurl': { monster: 'canopy-howler', kind: 'strike', width: 1.5, depth: 1.5, radius: 1.4, height: 0.2, damage: 12, timing: [48, 12, 10, 40] },
  'howler-leap-slam': { monster: 'canopy-howler', kind: 'strike', width: 2.2, depth: 2.2, radius: 2, height: 0.2, damage: 15, timing: [54, 12, 9, 48], lunge: { kind: 'step', meters: 5 } },
  'howler-branch-sweep': { monster: 'canopy-howler', kind: 'wave', width: 6, depth: 1.3, radius: 0, height: 0.18, damage: 11, timing: [48, 12, 12, 44] },
  'hornbill-dive-bomb': { monster: 'canopy-hornbill', element: 'wind', kind: 'sweep', width: 2, depth: 9, radius: 0, height: 1.1, damage: 15, timing: [60, 15, 20, 48], lunge: { kind: 'charge' }, lane: true },
  'hornbill-feather-volley': { monster: 'canopy-hornbill', element: 'wind', kind: 'cone', width: 6, depth: 7, radius: 0, height: 1.2, damage: 10, timing: [54, 12, 10, 44] },
  'hornbill-gale-flap': { monster: 'canopy-hornbill', element: 'wind', kind: 'wave', width: 7, depth: 1.6, radius: 0, height: 0.2, damage: 9, timing: [54, 15, 14, 48], push: 1.2 },
  'viper-venom-spit': { monster: 'canopy-mire-viper', element: 'poison', kind: 'area', width: 3.6, depth: 3.6, radius: 0, height: 1.2, damage: 4, timing: [48, 12, 180, 54], interval: 36, cast: 12 },
  'viper-tail-lash': { monster: 'canopy-mire-viper', kind: 'wave', width: 6.5, depth: 1.4, radius: 0, height: 0.18, damage: 12, timing: [54, 15, 14, 48] },
  'viper-strike-lunge': { monster: 'canopy-mire-viper', kind: 'sweep', width: 1.4, depth: 6, radius: 0, height: 0.8, damage: 16, timing: [36, 12, 8, 48], lunge: { kind: 'step', meters: 3.5 }, lane: true },
};


/** The real canopy variant loaded the way the playtest loads it, with an effectively unkillable Aren and world-space movement. */
function canopyEngine(index: number, options: { player?: Vec3; cursor?: number; mutate?: (seed: EngineState) => void } = {}): CombatEngine {
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: 'whispering-canopy', regionDefinition: region, runId: 'canopy-trials', presentActorIds: region.entities.map(entity => entity.id) });
  engine.startEncounter({ encounterId: 'canopy-trials', regionId: 'whispering-canopy', runId: 'canopy-trials' });
  engine.enableCombatTrials();
  const seed = engine.snapshotState();
  const trial = CANOPY_COMBAT_TRIALS[index]!;
  seed.combatTrial!.index = index;
  seed.player.vitality = seed.player.maxVitality = 1e6;
  seed.arena.cameraBasis = { forward: vec(0, 0, 1), right: vec(1, 0, 0) };
  const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z }, length = Math.hypot(toCenter.x, toCenter.z);
  const player = seed.actors.find(actor => actor.id === 'aren')!;
  player.position = options.player ?? vec(trial.monsterPosition.x + toCenter.x / length * 5.5, trial.monsterPosition.y, trial.monsterPosition.z + toCenter.z / length * 5.5);
  if (options.cursor !== undefined) seed.wildlifeCombat = { engagedTicks: 0, sourceCursor: 0, attackCursors: { [trial.monsterId]: options.cursor } };
  options.mutate?.(seed);
  return new CombatEngine(seed);
}
const monsterOf = (engine: CombatEngine, index: number) => engine.snapshot().actors.find(actor => actor.id === CANOPY_COMBAT_TRIALS[index]!.monsterId)!;
const playerOf = (engine: CombatEngine) => engine.snapshot().actors.find(actor => actor.id === 'aren')!;
const castCues = (events: readonly CombatEvent[], attackId: string) => events.filter(event => event.kind === 'cue' && event.attackId === attackId);

/** Steps until the monster begins `attackId`, as its first authored cast (the rotation cursor starts on it). */
function probeCast(index: number, attackId: string, player?: Vec3) {
  const trial = CANOPY_COMBAT_TRIALS[index]!;
  const engine = canopyEngine(index, { player, cursor: trial.attackIds.indexOf(attackId) });
  for (let tick = 0; tick < 600; tick++) {
    engine.fixedStep(idle);
    if (castCues(engine.consumeEvents(), attackId).length) {
      const state = engine.snapshotState();
      return { engine, state, hazard: state.hazards.find(hazard => hazard.attackId === attackId)!, monster: state.actors.find(actor => actor.id === trial.monsterId)! };
    }
  }
  throw new Error('no ' + attackId + ' cast');
}

describe('canopy attacks at runtime', () => {
  for (const [id, want] of Object.entries(CONTRACT)) {
    const index = CANOPY_COMBAT_TRIALS.findIndex(trial => trial.monsterId === want.monster);
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

  it('howler-leap-slam lunges up to 5 m towards the committed point during the commit window only', () => {
    const { engine, hazard, monster, state } = probeCast(0, 'howler-leap-slam', vec(-49 + 7, 0, -28 + 4));
    const lunge = monster.motion!.lunge!;
    expect(lunge.kind).toBe('step');
    expect(lunge.fromTick).toBe(hazard.windupUntil!);
    expect(lunge.toTick).toBe(hazard.activeFrom);
    const player = state.actors.find(actor => actor.id === 'aren')!;
    expect(lunge.travel).toBeCloseTo(Math.min(5, Math.max(0, dist(hazard.origin, player.position) - 3.5)), 6);
    expect(lunge.travel).toBeGreaterThan(0.5);
    const start = monster.position;
    while (engine.snapshotState().worldTick < lunge.fromTick) { engine.fixedStep(idle); engine.consumeEvents(); }
    expect(dist(monsterOf(engine, 0).position, start)).toBeLessThan(0.05);
    while (engine.snapshotState().worldTick < lunge.toTick) { engine.fixedStep(idle); engine.consumeEvents(); }
    expect(dist(monsterOf(engine, 0).position, start)).toBeGreaterThan(lunge.travel * 0.9);
    expect(dist(monsterOf(engine, 0).position, start)).toBeLessThanOrEqual(lunge.travel + 0.05);
  });

  it('hornbill-dive-bomb charges the whole lane during the active window', () => {
    const { engine, hazard, monster } = probeCast(1, 'hornbill-dive-bomb');
    const lunge = monster.motion!.lunge!;
    expect(lunge.kind).toBe('charge');
    expect(lunge.fromTick).toBe(hazard.activeFrom);
    expect(lunge.toTick).toBe(hazard.castUntil!);
    expect(lunge.travel).toBeCloseTo(Math.max(2, hazard.depth - 1), 6);
    const start = monster.position;
    while (engine.snapshotState().worldTick < lunge.toTick) { engine.fixedStep(idle); engine.consumeEvents(); }
    expect(dist(monsterOf(engine, 1).position, start)).toBeGreaterThan(Math.min(lunge.travel, 3) * 0.8);
    expect(dist(monsterOf(engine, 1).position, start)).toBeLessThanOrEqual(lunge.travel + 0.05);
  });

  it('viper-strike-lunge steps up to 3.5 m along its lane while the strike winds into its commit', () => {
    const { hazard, monster, state } = probeCast(2, 'viper-strike-lunge', vec(49 - 3, 0, -20 - 4.4));
    const lunge = monster.motion!.lunge;
    const player = state.actors.find(actor => actor.id === 'aren')!;
    const expected = Math.min(3.5, Math.max(0, dist(hazard.origin, player.position) - 3.5));
    if (expected > 0.05) {
      expect(lunge!.kind).toBe('step');
      expect(lunge!.travel).toBeCloseTo(expected, 6);
      expect(lunge!.toTick).toBe(hazard.activeFrom);
    } else expect(lunge).toBeUndefined();
  });

  it('hornbill-gale-flap pushes Aren 1.2 m along the gale when it connects', () => {
    const engine = canopyEngine(1, { cursor: 2 });
    let before = playerOf(engine).position, pushed: number | undefined, alignment = 0;
    for (let tick = 0; tick < 600 && pushed === undefined; tick++) {
      before = playerOf(engine).position;
      engine.fixedStep(idle);
      const hit = engine.consumeEvents().find(event => event.kind === 'damage' && event.attackId === 'hornbill-gale-flap');
      if (!hit) continue;
      const hazard = engine.snapshotState().hazards.find(candidate => candidate.attackId === 'hornbill-gale-flap')!;
      // The push is an eased knockback: measure once the slide has settled.
      for (let settle = 0; settle < 90 && playerOf(engine).reaction; settle++) { engine.fixedStep(idle); engine.consumeEvents(); }
      const after = playerOf(engine).position;
      pushed = dist(before, after);
      alignment = ((after.x - before.x) * hazard.direction.x + (after.z - before.z) * hazard.direction.z) / (pushed || 1);
    }
    expect(pushed).toBeCloseTo(1.2, 1);
    expect(alignment).toBeGreaterThan(0.99);
  });

  it('viper-venom-spit leaves a pool that pulses 4 damage every 36 ticks for 180 ticks, stays put, and does not chase', () => {
    const engine = canopyEngine(2, { cursor: 0 });
    const pulses: number[] = [];
    let pool: Vec3 | undefined;
    for (let tick = 0; tick < 420; tick++) {
      engine.fixedStep(idle);
      const events = engine.consumeEvents();
      for (const event of events) if (event.kind === 'damage' && event.attackId === 'viper-venom-spit') { pulses.push(event.damage!.worldTick); expect(event.damage!.amount).toBe(rampedDamage('whispering-canopy', 2, CANOPY_COMBAT_TRIALS.length, 4)); }
      const hazard = engine.snapshotState().hazards.find(candidate => candidate.attackId === 'viper-venom-spit');
      if (hazard) { pool ??= { ...hazard.target }; expect(hazard.target).toEqual(pool); }
    }
    expect(pulses.length).toBeGreaterThanOrEqual(5);
    for (let index = 1; index < pulses.length; index++) expect(pulses[index]! - pulses[index - 1]!).toBe(36);
    expect(pulses[pulses.length - 1]! - pulses[0]!).toBeLessThanOrEqual(180);
  });

  it('viper-venom-spit deals nothing to an Aren who leaves the pool before it opens', () => {
    const engine = canopyEngine(2, { cursor: 0 });
    let castAt = -1, venom = 0, heading = vec(0, 0, 0);
    for (let tick = 0; tick < 420; tick++) {
      // After the cast starts, walk straight away from the viper (the pool is centred where Aren stood), clear of it before it opens.
      const leaving = castAt >= 0 && tick < castAt + 50;
      engine.fixedStep(leaving ? { ...idle, move: heading, sprintHeld: true } : idle);
      const events = engine.consumeEvents();
      if (castAt < 0 && castCues(events, 'viper-venom-spit').length) {
        castAt = tick;
        const direction = engine.snapshotState().hazards.find(hazard => hazard.attackId === 'viper-venom-spit')!.direction;
        heading = vec(direction.x, 0, direction.z);
      }
      venom += events.filter(event => event.kind === 'damage' && event.attackId === 'viper-venom-spit').length;
    }
    expect(castAt).toBeGreaterThanOrEqual(0);
    expect(venom).toBe(0);
  });

  it('non-elemental canopy attacks use the generic attack-keyed presentation cues, elemental ones carry their element', () => {
    for (const [index, id] of [[0, 'howler-rock-hurl'], [1, 'hornbill-feather-volley'], [2, 'viper-tail-lash']] as const) {
      const engine = canopyEngine(index, { cursor: CANOPY_COMBAT_TRIALS[index]!.attackIds.indexOf(id) });
      const cues: { kind: string; attackId?: string; element?: string }[] = [];
      for (let tick = 0; tick < 400 && !cues.some(cue => cue.kind === 'active' && cue.attackId === id); tick++) {
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

describe('canopy trial monsters', () => {
  for (const [index, trial] of CANOPY_COMBAT_TRIALS.entries()) {
    it(`${trial.title}: stays inside its arena and cycles its authored roster in order`, () => {
      const engine = canopyEngine(index);
      const casts: string[] = [];
      for (let tick = 0; tick < 3000; tick++) {
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
      const far = (range: number) => vec(trial.monsterPosition.x + toCenter.x / length * range, trial.monsterPosition.y, trial.monsterPosition.z + toCenter.z / length * range);
      const engage = canopyEngine(index, { player: far(profile.bandMax + 2) });
      let roars = 0, damage = 0;
      for (let tick = 0; tick < ROAR_TICKS - 2; tick++) {
        engage.fixedStep(idle);
        damage += engage.consumeEvents().filter(event => event.kind === 'damage').length;
        roars += engage.drainPresentationCues().filter(cue => cue.kind === 'roar-cone' && cue.actorId === trial.monsterId).length;
      }
      expect(roars).toBe(1);
      expect(damage).toBe(0);
      expect(monsterOf(engage, index).attackPhase).toBeUndefined();

      const escalate = new CombatEngine(canopyEngine(index, { mutate: seed => { seed.wildlifeCombat = { engagedTicks: 898, sourceCursor: 0, attackCursors: {} }; seed.actors.find(actor => actor.id === trial.monsterId)!.recoveringUntil = 1e6; } }).snapshotState());
      const escalations = [];
      for (let tick = 0; tick < 200; tick++) {
        escalate.fixedStep(idle);
        escalations.push(...escalate.drainPresentationCues().filter(cue => cue.kind === 'roar-cone' && cue.actorId === trial.monsterId));
      }
      expect(escalations).toHaveLength(1);
    });
  }
});

